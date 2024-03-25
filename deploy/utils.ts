import { Provider, Wallet } from 'zksync-ethers';
import * as hre from 'hardhat';
import { Deployer } from '@matterlabs/hardhat-zksync-deploy';
import dotenv from 'dotenv';
import { ethers } from 'ethers';
import { getImplementationAddress } from '@openzeppelin/upgrades-core';
import * as fs from 'fs';
import * as path from 'path';

import '@matterlabs/hardhat-zksync-node/dist/type-extensions';
import '@matterlabs/hardhat-zksync-verify/dist/src/type-extensions';
import { sleep } from 'zksync-ethers/build/utils';

// Load env file
dotenv.config();

export const createOrGetDeployLog = (networkName: string) => {
  const zkLinkRoot = path.resolve(__dirname, '..');
  const deployLogPath = `${zkLinkRoot}/log/${networkName}.log`;
  console.log('deploy log path', deployLogPath);
  const logPath = path.dirname(deployLogPath);
  if (!fs.existsSync(logPath)) {
    fs.mkdirSync(logPath, { recursive: true });
  }

  let deployLog = {};
  if (fs.existsSync(deployLogPath)) {
    const data = fs.readFileSync(deployLogPath, 'utf8');
    deployLog = JSON.parse(data);
  }
  return { deployLogPath, deployLog };
};

export const getProvider = () => {
  const rpcUrl = hre.network.config.url;
  if (!rpcUrl)
    throw `⛔️ RPC URL wasn't found in "${hre.network.name}"! Please add a "url" field to the network config in hardhat.config.ts`;

  // console.log("rpcUrl", rpcUrl);

  // Initialize zkSync Provider
  const provider = new Provider(rpcUrl);

  return provider;
};

export const getWallet = (privateKey?: string) => {
  if (!privateKey) {
    // Get wallet private key from .env file
    if (!process.env.WALLET_PRIVATE_KEY) throw "⛔️ Wallet private key wasn't found in .env file!";
  }

  const provider = getProvider();

  // Initialize zkSync Wallet
  const wallet = new Wallet(privateKey ?? process.env.WALLET_PRIVATE_KEY!, provider);

  return wallet;
};

export const verifyEnoughBalance = async (wallet: Wallet, amount: bigint) => {
  // Check if the wallet has enough balance
  const balance = await wallet.getBalance();
  console.log('Balance of Wallet: ' + balance);

  if (balance < amount) {
    throw `⛔️ Wallet balance is too low! Required ${ethers.formatEther(amount)} ETH, but current ${wallet.address} balance is ${ethers.formatEther(balance)} ETH`;
  }
};

/**
 * @param {string} data.contract The contract's path and name. E.g., "contracts/Greeter.sol:Greeter"
 */
export const verifyContract = async (data: {
  address: string;
  contract: string;
  constructorArguments: string;
  bytecode: string;
}) => {
  const verificationRequestId: number = await hre.run('verify:verify', {
    ...data,
    noCompile: true,
  });
  return verificationRequestId;
};

type DeployContractOptions = {
  /**
   * If true, the deployment process will not print any logs
   */
  silent?: boolean;
  /**
   * If true, the contract will not be verified on Block Explorer
   */
  noVerify?: boolean;
  /**
   * If specified, the contract will be deployed using this wallet
   */
  wallet?: Wallet;

  upgradable?: boolean;

  kind?: 'uups' | 'transparent' | 'beacon' | undefined;

  unsafeAllow?:
  | (
    | 'constructor'
    | 'delegatecall'
    | 'selfdestruct'
    | 'state-variable-assignment'
    | 'state-variable-immutable'
    | 'external-library-linking'
    | 'struct-definition'
    | 'enum-definition'
    | 'missing-public-upgradeto'
  )[]
  | undefined;
};
export const deployContract = async (
  contractArtifactName: string,
  constructorArguments?: any[],
  options?: DeployContractOptions,
  initializerArguments?: any[],
) => {
  const log = (message: string) => {
    if (!options?.silent) console.log(message);
  };

  const { deployLogPath, deployLog } = createOrGetDeployLog(hre.network.name);

  log(`\nStarting deployment process of "${contractArtifactName}"...`);

  const wallet = options?.wallet ?? getWallet();
  const deployer = new Deployer(hre, wallet);
  const artifact = await deployer.loadArtifact(contractArtifactName).catch(error => {
    if (error?.message?.includes(`Artifact for contract "${contractArtifactName}" not found.`)) {
      console.error(error.message);
      throw `⛔️ Please make sure you have compiled your contracts or specified the correct contract name!`;
    } else {
      throw error;
    }
  });

  log(`\nArtifact found! Deploying contract...`);
  const contractName = artifact.contractName;

  // Estimate contract deployment fee
  const deploymentFee = await deployer.estimateDeployFee(artifact, constructorArguments || []);
  log(`Estimated deployment cost: ${ethers.formatEther(deploymentFee)} ETH`);

  // Check if the wallet has enough balance
  await verifyEnoughBalance(wallet, deploymentFee);

  log(`\nDeploying contract...`);
  log(`\nConstructor arguments: ${JSON.stringify(constructorArguments, null, 2)}`);
  let contract;

  // Deploy the contract to zkSync
  if (options?.upgradable) {
    contract = await hre.zkUpgrades.deployProxy(deployer.zkWallet, artifact, initializerArguments, {
      initializer: 'initialize',
      kind: options.kind,
      unsafeAllow: options.unsafeAllow,
      constructorArgs: constructorArguments,
    });
  } else {
    contract = await deployer.deploy(artifact, constructorArguments);
  }

  log(`\nContract deployed!`);

  const address = await contract.getAddress();
  const constructorArgs = contract.interface.encodeDeploy(constructorArguments);
  const fullContractSource = `${artifact.sourceName}:${contractName}`;

  (deployLog as any)[contractName] = address;
  if (options?.upgradable) {
    const implementationAddress = await getImplementationAddress(getProvider(), address);
    (deployLog as any)[`${contractName}_Implementation`] = implementationAddress;
  }
  fs.writeFileSync(deployLogPath, JSON.stringify(deployLog, null, 2));

  // Display contract deployment info
  log(`\n"${contractName}" was successfully deployed:`);
  log(` - Contract address: ${address}`);
  log(` - Contract source: ${fullContractSource}`);
  log(` - Encoded constructor arguments: ${constructorArgs}\n`);

  if (!options?.noVerify && hre.network.config.verifyURL) {
    log(`Requesting contract verification...`);

    await verifyContract({
      address,
      contract: fullContractSource,
      constructorArguments: constructorArgs,
      bytecode: artifact.bytecode,
    });
  }

  return contract;
};

export const upgradeContract = async (
  contractArtifactName: string,
  constructorArguments?: any[],
  options?: DeployContractOptions,
) => {
  const log = (message: string) => {
    if (!options?.silent) console.log(message);
  };

  const { deployLogPath, deployLog } = createOrGetDeployLog(hre.network.name);

  log(`\nStarting upgrade process of "${contractArtifactName}"...`);

  const wallet = options?.wallet ?? getWallet();
  const deployer = new Deployer(hre, wallet);
  const artifact = await deployer.loadArtifact(contractArtifactName).catch(error => {
    if (error?.message?.includes(`Artifact for contract "${contractArtifactName}" not found.`)) {
      console.error(error.message);
      throw `Please make sure you have compiled your contracts or specified the correct contract name!`;
    } else {
      throw error;
    }
  });

  log(`\nArtifact found! Deploying contract...`);
  const contractName = artifact.contractName;

  // Estimate contract deployment fee
  const deploymentFee = await deployer.estimateDeployFee(artifact, constructorArguments || []);
  log(`Estimated deployment cost: ${ethers.formatEther(deploymentFee)} ETH`);

  // Check if the wallet has enough balance
  await verifyEnoughBalance(wallet, deploymentFee);

  log(`\nDeploying new implementation contract...`);
  log(`\nConstructor arguments: ${JSON.stringify(constructorArguments, null, 2)}`);

  // Deploy the contract to zkSync
  if (options?.upgradable) {
    const proxyAddress = (deployLog as any)[contractName];
    console.log('proxyAddress', proxyAddress);
    if (!proxyAddress) {
      throw new Error('⛔️ Proxy address not found! Please deploy the contract first.');
    }

    await hre.zkUpgrades.upgradeProxy(deployer.zkWallet, proxyAddress, artifact, {
      unsafeAllow: options.unsafeAllow,
      constructorArgs: constructorArguments,
    });

    await sleep(2_000);
    const implementationAddress = await getImplementationAddress(getProvider(), proxyAddress);
    log(`\nNew implementation address: ${implementationAddress}`);

    (deployLog as any)[`${contractName}_Implementation`] = implementationAddress;
    fs.writeFileSync(deployLogPath, JSON.stringify(deployLog, null, 2));
  } else {
    throw `⛔️ Upgrade contract must be upgradable!`;
  }

  log(`\nContract upgraded!`);
  const contract = await hre.ethers.getContractAt(artifact.abi, (deployLog as any)[contractName]);
  const address = await contract.getAddress();
  const constructorArgs = contract.interface.encodeDeploy(constructorArguments);
  const fullContractSource = `${artifact.sourceName}:${contractName}`;

  // Display contract deployment info
  log(`\n"${contractName}" was successfully deployed:`);
  log(` - Contract address: ${address}`);
  log(` - Contract source: ${fullContractSource}`);
  log(` - Encoded constructor arguments: ${constructorArgs}\n`);

  if (!options?.noVerify && hre.network.config.verifyURL) {
    log(`Requesting contract verification...`);

    await verifyContract({
      address,
      contract: fullContractSource,
      constructorArguments: constructorArgs,
      bytecode: artifact.bytecode,
    });
  }

  return contract;
};

export const verifyContractByName = async (
  proxyAddress: string,
  contractArtifactName: string,
  constructorArguments?: any[],
) => {
  const wallet = getWallet();
  const deployer = new Deployer(hre, wallet);

  const artifact = await deployer.loadArtifact(contractArtifactName).catch(error => {
    if (error?.message?.includes(`Artifact for contract "${contractArtifactName}" not found.`)) {
      console.error(error.message);
      throw `Please make sure you have compiled your contracts or specified the correct contract name!`;
    } else {
      throw error;
    }
  });

  const contractName = artifact.contractName;
  console.log('proxyAddress', proxyAddress);
  if (!proxyAddress) {
    throw new Error('⛔️ Proxy address not found! Please deploy the contract first.');
  }

  const implementationAddress = await getImplementationAddress(getProvider(), proxyAddress);
  console.log(`\nNew implementation address: ${implementationAddress}`);

  const contract = await hre.ethers.getContractAt(artifact.abi, proxyAddress);
  const address = await contract.getAddress();
  const constructorArgs = contract.interface.encodeDeploy(constructorArguments);
  const fullContractSource = `${artifact.sourceName}:${contractName}`;

  // Display contract deployment info
  console.log(`\n"${contractName}" was successfully deployed:`);
  console.log(` - Contract address: ${address}`);
  console.log(` - Contract source: ${fullContractSource}`);
  console.log(` - Encoded constructor arguments: ${constructorArgs}\n`);
  console.log(`Requesting contract verification...`);

  await verifyContract({
    address,
    contract: fullContractSource,
    constructorArguments: constructorArgs,
    bytecode: artifact.bytecode,
  });
};

/**
 * Rich wallets can be used for testing purposes.
 * Available on zkSync In-memory node and Dockerized node.
 */
export const LOCAL_RICH_WALLETS = [
  {
    address: '0x36615Cf349d7F6344891B1e7CA7C72883F5dc049',
    privateKey: '0x7726827caac94a7f9e1b160f7ea819f172f7b6f9d2a97f992c38edeab82d4110',
  },
  {
    address: '0xa61464658AfeAf65CccaaFD3a512b69A83B77618',
    privateKey: '0xac1e735be8536c6534bb4f17f06f6afc73b2b5ba84ac2cfb12f7461b20c0bbe3',
  },
  {
    address: '0x0D43eB5B8a47bA8900d84AA36656c92024e9772e',
    privateKey: '0xd293c684d884d56f8d6abd64fc76757d3664904e309a0645baf8522ab6366d9e',
  },
  {
    address: '0xA13c10C0D5bd6f79041B9835c63f91de35A15883',
    privateKey: '0x850683b40d4a740aa6e745f889a6fdc8327be76e122f5aba645a5b02d0248db8',
  },
  {
    address: '0x8002cD98Cfb563492A6fB3E7C8243b7B9Ad4cc92',
    privateKey: '0xf12e28c0eb1ef4ff90478f6805b68d63737b7f33abfa091601140805da450d93',
  },
  {
    address: '0x4F9133D1d3F50011A6859807C837bdCB31Aaab13',
    privateKey: '0xe667e57a9b8aaa6709e51ff7d093f1c5b73b63f9987e4ab4aa9a5c699e024ee8',
  },
  {
    address: '0xbd29A1B981925B94eEc5c4F1125AF02a2Ec4d1cA',
    privateKey: '0x28a574ab2de8a00364d5dd4b07c4f2f574ef7fcc2a86a197f65abaec836d1959',
  },
  {
    address: '0xedB6F5B4aab3dD95C7806Af42881FF12BE7e9daa',
    privateKey: '0x74d8b3a188f7260f67698eb44da07397a298df5427df681ef68c45b34b61f998',
  },
  {
    address: '0xe706e60ab5Dc512C36A4646D719b889F398cbBcB',
    privateKey: '0xbe79721778b48bcc679b78edac0ce48306a8578186ffcb9f2ee455ae6efeace1',
  },
  {
    address: '0xE90E12261CCb0F3F7976Ae611A29e84a6A85f424',
    privateKey: '0x3eb15da85647edd9a1159a4a13b9e7c56877c4eb33f614546d4db06a51868b1c',
  },
];
