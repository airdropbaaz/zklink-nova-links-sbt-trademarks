import * as hre from "hardhat";
import { getWallet } from "./utils";
import { ethers } from "ethers";
import { getSignature } from "./witness";

// Address of the contract to interact with
const CONTRACT_ADDRESS = "0xF2fe005206cF81C149EbB2D40A294F5Ac59D9E6D";
if (!CONTRACT_ADDRESS)
  throw "⛔️ Provide address of the contract to interact with!";

const accountAddress = "0xe269B18099A71599994312757fEf8DEBE7518C31";

// An example of a script to interact with the contract
export default async function () {
  console.log(`Running script to interact with contract ${CONTRACT_ADDRESS}`);

  if (!process.env.WITNESS_SINGER_PRIVATE_KEY) {
    throw "⛔️ Provide WITNESS_SINGER_PRIVATE_KEY";
  }
  // Load compiled contract info
  const contractArtifact = await hre.artifacts.readArtifact("NovaNFT");

  // Initialize contract instance for interaction
  const contract = new ethers.Contract(
    CONTRACT_ADDRESS,
    contractArtifact.abi,
    getWallet() // Interact with the contract on behalf of this wallet
  );

  // Run contract read function
  const response = await contract.balanceOf(accountAddress);
  console.log(`Current Balance is: ${response}`);

  const character = ["ISTP", "ESFJ", "INFJ", "ENTP"][(Math.random() * 4) | 0];

  console.log(`Minting: ${character}`);

  // Run contract write function
  const transaction = await contract["safeMint(address,string,bytes)"](
    accountAddress,
    character,
    getSignature(
      accountAddress,
      "NOVA-SBT-1",
      process.env.WITNESS_SINGER_PRIVATE_KEY || ""
    )
  );
  console.log(`Transaction hash of setting new message: ${transaction.hash}`);

  // Wait until transaction is processed
  await transaction.wait();

  // Read message after transaction
  console.log(
    `The balance now is: ${await contract.balanceOf(accountAddress)}`
  );
}
