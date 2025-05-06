const fs = require('fs');
const path = require('path');
const { ethers, JsonRpcProvider } = require('ethers');
const axios = require('axios');
const moment = require('moment-timezone');
const readline = require('readline');
const { DirectSecp256k1HdWallet } = require('@cosmjs/proto-signing');
require('dotenv').config();

const colors = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  white: "\x1b[37m",
  bold: "\x1b[1m"
};

const logger = {
  info: (msg) => console.log(`${colors.green}[✓] ${msg}${colors.reset}`),
  warn: (msg) => console.log(`${colors.yellow}[⚠] ${msg}${colors.reset}`),
  error: (msg) => console.log(`${colors.red}[✗] ${msg}${colors.reset}`),
  success: (msg) => console.log(`${colors.green}[✅] ${msg}${colors.reset}`),
  loading: (msg) => console.log(`${colors.cyan}[⟳] ${msg}${colors.reset}`),
  step: (msg) => console.log(`${colors.white}[➤] ${msg}${colors.reset}`),
  banner: () => {
    console.log(`${colors.cyan}${colors.bold}`);
    console.log(`---------------------------------------------`);
    console.log(`  Union Testnet Auto Bot - Airdrop Insiders  `);
    console.log(`---------------------------------------------${colors.reset}`);
    console.log();
  }
};

const UCS03_ABI = [
  {
    inputs: [
      { internalType: 'uint32', name: 'channelId', type: 'uint32' },
      { internalType: 'uint64', name: 'timeoutHeight', type: 'uint64' },
      { internalType: 'uint64', name: 'timeoutTimestamp', type: 'uint64' },
      { internalType: 'bytes32', name: 'salt', type: 'bytes32' },
      {
        components: [
          { internalType: 'uint8', name: 'version', type: 'uint8' },
          { internalType: 'uint8', name: 'opcode', type: 'uint8' },
          { internalType: 'bytes', name: 'operand', type: 'bytes' },
        ],
        internalType: 'struct Instruction',
        name: 'instruction',
        type: 'tuple',
      },
    ],
    name: 'send',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
];

const USDC_ABI = [
  {
    constant: true,
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    type: 'function',
    stateMutability: 'view',
  },
  {
    constant: true,
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ name: '', type: 'uint256' }],
    type: 'function',
    stateMutability: 'view',
  },
  {
    constant: false,
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: '', type: 'bool' }],
    type: 'function',
    stateMutability: 'nonpayable',
  },
];

const contractAddress = '0x5FbE74A283f7954f10AA04C2eDf55578811aeb03';
const USDC_ADDRESS = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const graphqlEndpoint = 'https://graphql.union.build/v1/graphql';
const baseExplorerUrl = 'https://sepolia.etherscan.io';
const unionUrl = 'https://app.union.build/explorer';

const rpcProviders = [new JsonRpcProvider('https://eth-sepolia.public.blastapi.io')];
let currentRpcProviderIndex = 0;

function provider() {
  return rpcProviders[currentRpcProviderIndex];
}

function rotateRpcProvider() {
  currentRpcProviderIndex = (currentRpcProviderIndex + 1) % rpcProviders.length;
  return provider();
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function askQuestion(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

const explorer = {
  tx: (txHash) => `${baseExplorerUrl}/tx/${txHash}`,
  address: (address) => `${baseExplorerUrl}/address/${address}`,
};

const union = {
  tx: (txHash) => `${unionUrl}/transfers/${txHash}`,
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function timelog() {
  return moment().tz('Asia/Jakarta').format('HH:mm:ss | DD-MM-YYYY');
}

function header() {
  process.stdout.write('\x1Bc');
  logger.banner();
}

async function pollPacketHash(txHash, retries = 50, intervalMs = 5000) {
  const headers = {
    accept: 'application/graphql-response+json, application/json',
    'accept-encoding': 'gzip, deflate, br, zstd',
    'accept-language': 'en-US,en;q=0.9,id;q=0.8',
    'content-type': 'application/json',
    origin: 'https://app-union.build',
    referer: 'https://app.union.build/',
    'user-agent': 'Mozilla/5.0',
  };
  const data = {
    query: `
      query ($submission_tx_hash: String!) {
        v2_transfers(args: {p_transaction_hash: $submission_tx_hash}) {
          packet_hash
        }
      }
    `,
    variables: {
      submission_tx_hash: txHash.startsWith('0x') ? txHash : `0x${txHash}`,
    },
  };

  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.post(graphqlEndpoint, data, { headers });
      const result = res.data?.data?.v2_transfers;
      if (result && result.length > 0 && result[0].packet_hash) {
        return result[0].packet_hash;
      }
    } catch (e) {
      logger.error(`Packet error: ${e.message}`);
    }
    await delay(intervalMs);
  }
  logger.warn(`No packet hash found after ${retries} retries.`);
  return null;
}

async function checkBalanceAndApprove(wallet, usdcAddress, spenderAddress) {
  const usdcContract = new ethers.Contract(usdcAddress, USDC_ABI, wallet);
  const balance = await usdcContract.balanceOf(wallet.address);
  if (balance === 0n) {
    logger.error(`${wallet.address} not have enough USDC. Fund your wallet first!`);
    return false;
  }

  const allowance = await usdcContract.allowance(wallet.address, spenderAddress);
  if (allowance === 0n) {
    logger.loading(`USDC is not allowance. Sending approve transaction....`);
    const approveAmount = ethers.MaxUint256;
    try {
      const tx = await usdcContract.approve(spenderAddress, approveAmount);
      const receipt = await tx.wait();
      logger.success(`Approve confirmed: ${explorer.tx(receipt.hash)}`);
      await delay(3000);
    } catch (err) {
      logger.error(`Approve failed: ${err.message}`);
      return false;
    }
  }
  return true;
}

async function sendFromWallet(walletInfo, maxTransaction, destination) {
  const wallet = new ethers.Wallet(walletInfo.privatekey, provider());
  let recipientAddress, destinationName, channelId, operand;

  if (destination === 'babylon') {
    recipientAddress = walletInfo.babylonAddress;
    destinationName = 'Babylon';
    channelId = 7;
    if (!recipientAddress) {
      logger.warn(`Skipping wallet '${walletInfo.name || 'Unnamed'}': Missing babylonAddress.`);
      return;
    }
  } else if (destination === 'holesky') {
    recipientAddress = wallet.address;
    destinationName = 'Holesky';
    channelId = 8;
  } else {
    logger.error(`Invalid destination: ${destination}`);
    return;
  }

  logger.loading(`Sending ${maxTransaction} Transaction Sepolia to ${destinationName} from ${wallet.address} (${walletInfo.name || 'Unnamed'})`);
  const shouldProceed = await checkBalanceAndApprove(wallet, USDC_ADDRESS, contractAddress);
  if (!shouldProceed) return;

  const contract = new ethers.Contract(contractAddress, UCS03_ABI, wallet);
  const senderHex = wallet.address.slice(2).toLowerCase();
  const recipientHex = destination === 'babylon' ? Buffer.from(recipientAddress, "utf8").toString("hex") : senderHex;
  const timeoutHeight = 0;

  if (destination === 'babylon') {
    operand = `0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000001e00000000000000000000000000000000000000000000000000000000000002710000000000000000000000000000000000000000000000000000000000000022000000000000000000000000000000000000000000000000000000000000002600000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002a000000000000000000000000000000000000000000000000000000000000027100000000000000000000000000000000000000000000000000000000000000014${senderHex}000000000000000000000000000000000000000000000000000000000000000000000000000000000000002a${recipientHex}0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000141c7d4b196cb0c7b01d743fbc6116a902379c72380000000000000000000000000000000000000000000000000000000000000000000000000000000000000004555344430000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000045553444300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003e62626e317a7372763233616b6b6778646e77756c3732736674677632786a74356b68736e743377776a687030666668363833687a7035617135613068366e0000`;
  } else {
    operand = `0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000002c00000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000018000000000000000000000000000000000000000000000000000000000000001c000000000000000000000000000000000000000000000000000000000000027100000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000024000000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000028000000000000000000000000000000000000000000000000000000000000027100000000000000000000000000000000000000000000000000000000000000014${senderHex}0000000000000000000000000000000000000000000000000000000000000000000000000000000000000014${senderHex}00000000000000000000000000000000000000000000000000000000000000000000000000000000000000141c7d4b196cb0c7b01d743fbc6116a902379c72380000000000000000000000000000000000000000000000000000000000000000000000000000000000000004555344430000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000045553444300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001457978bfe465ad9b1c0bf80f6c1539d300705ea50000000000000000000000000`;
  }

  for (let i = 1; i <= maxTransaction; i++) {
    logger.step(`${walletInfo.name || 'Unnamed'} | Transaction ${i}/${maxTransaction}`);
    const now = BigInt(Date.now()) * 1_000_000n;
    const oneDayNs = 86_400_000_000_000n;
    const timeoutTimestamp = (now + oneDayNs).toString();
    const timestampNow = Math.floor(Date.now() / 1000);
    const salt = ethers.keccak256(ethers.solidityPacked(['address', 'uint256'], [wallet.address, timestampNow]));
    const instruction = {
      version: 0,
      opcode: 2,
      operand,
    };

    try {
      const tx = await contract.send(channelId, timeoutHeight, timeoutTimestamp, salt, instruction);
      await tx.wait(1);
      logger.success(`${timelog()} | ${walletInfo.name || 'Unnamed'} | Transaction Confirmed: ${explorer.tx(tx.hash)}`);
      const txHash = tx.hash.startsWith('0x') ? tx.hash : `0x${tx.hash}`;
      const packetHash = await pollPacketHash(txHash);
      if (packetHash) {
        logger.success(`${timelog()} | ${walletInfo.name || 'Unnamed'} | Packet Submitted: ${union.tx(packetHash)}`);
      }
      console.log('');
    } catch (err) {
      logger.error(`Failed for ${wallet.address}: ${err.message}`);
      console.log('');
    }

    if (i < maxTransaction) {
      await delay(1000);
    }
  }
}

async function main() {
  header();

  const wallets = [];
  let index = 1;
  while (true) {
    const privateKey = process.env[`PRIVATE_KEY_${index}`];
    const babylonAddress = process.env[`BABYLON_ADDRESS_${index}`];
    if (!privateKey) break; 
    wallets.push({
      name: `Wallet${index}`,
      privatekey: privateKey,
      babylonAddress: babylonAddress || ''
    });
    index++;
  }

  if (wallets.length === 0) {
    logger.error(`No wallets found in .env. Please provide at least one PRIVATE_KEY_X.`);
    process.exit(1);
  }

  while (true) {
    console.log(`${colors.cyan}Menu:${colors.reset}`);
    console.log(`1. Sepolia - Holesky`);
    console.log(`2. Sepolia - Babylon`);
    console.log(`3. Random (Holesky and Babylon)`);
    console.log(`4. Exit`);
    const menuChoice = await askQuestion(`${colors.cyan}[?] Select menu option (1-4): ${colors.reset}`);
    const choice = parseInt(menuChoice.trim());

    if (choice === 4) {
      logger.info(`Exiting program.`);
      rl.close();
      process.exit(0);
    }

    if (![1, 2, 3].includes(choice)) {
      logger.error(`Invalid option. Please select 1, 2, 3, or 4.`);
      continue;
    }

    const maxTransactionInput = await askQuestion(`${colors.cyan}[?] Enter the number of transactions per wallet: ${colors.reset}`);
    const maxTransaction = parseInt(maxTransactionInput.trim());

    if (isNaN(maxTransaction) || maxTransaction <= 0) {
      logger.error(`Invalid number. Please enter a positive number.`);
      continue;
    }

    for (const walletInfo of wallets) {
      if (!walletInfo.privatekey) {
        logger.warn(`Skipping wallet '${walletInfo.name}': Missing privatekey.`);
        continue;
      }
      if (!walletInfo.privatekey.startsWith('0x')) {
        logger.warn(`Skipping wallet '${walletInfo.name}': Privatekey must start with '0x'.`);
        continue;
      }
      if (!/^(0x)[0-9a-fA-F]{64}$/.test(walletInfo.privatekey)) {
        logger.warn(`Skipping wallet '${walletInfo.name}': Privatekey is not a valid 64-character hexadecimal string.`);
        continue;
      }

      if (choice === 1) {
        await sendFromWallet(walletInfo, maxTransaction, 'holesky');
      } else if (choice === 2) {
        await sendFromWallet(walletInfo, maxTransaction, 'babylon');
      } else if (choice === 3) {
        const destinations = ['holesky', 'babylon'].filter(dest => dest !== 'babylon' || walletInfo.babylonAddress);
        if (destinations.length === 0) {
          logger.warn(`Skipping wallet '${walletInfo.name}': No valid destinations (missing babylonAddress).`);
          continue;
        }
        for (let i = 0; i < maxTransaction; i++) {
          const randomDest = destinations[Math.floor(Math.random() * destinations.length)];
          await sendFromWallet(walletInfo, 1, randomDest);
          if (i < maxTransaction - 1) {
            await delay(1000);
          }
        }
      }
    }

    if (wallets.length === 0) {
      logger.warn(`No wallets processed. Check .env for valid entries.`);
    }
  }
}

main().catch((err) => {
  logger.error(`Main error: ${err.message}`);
  rl.close();
  process.exit(1);
});