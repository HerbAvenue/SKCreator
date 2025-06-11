#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const readline = require("readline");
const { execSync, spawn } = require("child_process");
const { createGunzip } = require("zlib");
const tar = require("tar");

const repoRoot = path.join(__dirname, "ipfs-user-profile");
process.env.IPFS_PATH = repoRoot;

const platform = os.platform();
const arch = os.arch() === "x64" ? "amd64" : os.arch();
const kuboVersion = "v0.24.0";
const kuboURL = `https://dist.ipfs.tech/kubo/${kuboVersion}/kubo_${kuboVersion}_${
  platform === "win32" ? "windows" : platform
}-${arch}.tar.gz`;

const localBinDir = path.join(__dirname, "ipfs-bin");
const ipfsCmd = path.join(localBinDir, "ipfs");
const userKeyFile = path.join(__dirname, "profile.key");

function run(cmd, opts = {}) {
  try {
    const fullCmd = cmd.startsWith("ipfs ")
      ? cmd.replace(/^ipfs/, `"${ipfsCmd}"`)
      : cmd;
    return execSync(fullCmd, {
      stdio: "pipe",
      env: { ...process.env, IPFS_PATH: repoRoot },
      ...opts,
    })
      .toString()
      .trim();
  } catch (err) {
    console.error(`❌ Failed: ${cmd}\n${err.message}`);
    process.exit(1);
  }
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function prompt(q) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) =>
    rl.question(q, (a) => {
      rl.close();
      resolve(a.trim());
    })
  );
}

function checkIPFS() {
  if (!fs.existsSync(ipfsCmd)) return false;
  try {
    execSync(`${ipfsCmd} --version`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

async function downloadAndInstallIPFS() {
  console.log(`📦 IPFS not found. Downloading ${kuboURL}`);
  ensureDir(localBinDir);

  await new Promise((resolve, reject) => {
    https.get(kuboURL, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to download: ${res.statusCode}`));
      }
      res
        .pipe(createGunzip())
        .pipe(
          tar.x({
            cwd: localBinDir,
            strip: 1,
          })
        )
        .on("finish", resolve)
        .on("error", reject);
    });
  });

  const finalPath = path.join(localBinDir, "ipfs");
  if (!fs.existsSync(finalPath)) {
    const sub = path.join(localBinDir, "kubo");
    const ipfsBinary = fs.readdirSync(sub).find((f) => f === "ipfs");
    if (ipfsBinary) {
      fs.copyFileSync(path.join(sub, ipfsBinary), finalPath);
      fs.chmodSync(finalPath, 0o755);
    } else {
      throw new Error("ipfs binary not found in downloaded tar.");
    }
  }

  console.log("✅ IPFS installed locally.");
}

function initIPFSRepo() {
  if (!fs.existsSync(path.join(repoRoot, "config"))) {
    run("ipfs init");
  }

  run("ipfs config Addresses.Gateway /ip4/127.0.0.1/tcp/8080");
  run("ipfs config Addresses.API /ip4/127.0.0.1/tcp/5001");
}

function importUserKey() {
  const keyList = run("ipfs key list");
  const keyExists = keyList.split("\n").includes("profile");

  if (keyExists) {
    console.log("✅ IPNS key 'profile' already exists.");
    return;
  }

  if (fs.existsSync(userKeyFile)) {
    console.log("🔑 Importing saved IPNS key...");
    run(`ipfs key import profile "${userKeyFile}"`);
  } else {
    console.log("🆕 Generating new IPNS key 'profile'...");
    run("ipfs key gen profile --type=rsa --size=2048");
  }
}

function killPortIfUsed(port = 5001) {
  try {
    const pid = execSync(`lsof -ti tcp:${port}`).toString().trim();
    if (pid) {
      const cmd = execSync(`ps -p ${pid} -o comm=`).toString().trim();
      if (cmd.includes("ipfs")) {
        console.log(`🔪 Killing IPFS on port ${port} (PID: ${pid})...`);
        execSync(`kill -9 ${pid}`);
      } else {
        console.warn(
          `⚠️ Port ${port} in use by non-IPFS process (${cmd}). Skipping kill.`
        );
      }
    }
  } catch {
    // Port is free or lsof not installed
  }
}

async function main() {
  killPortIfUsed(5001); // 👈 kill any existing IPFS daemon on 5001

  if (!checkIPFS()) {
    await downloadAndInstallIPFS();
  }

  initIPFSRepo();
  importUserKey();

  console.log("🚀 Starting IPFS node...");
  const daemon = spawn(ipfsCmd, ["daemon"], {
    env: { ...process.env, IPFS_PATH: repoRoot },
    stdio: "inherit",
  });

  await new Promise((r) => setTimeout(r, 3000));

  const name = await prompt("Name: ");
  const bio = await prompt("Bio: ");
  const post = await prompt("First post: ");
  const timestamp = new Date().toISOString();

  const base = path.join(__dirname, "profile");
  const postsDir = path.join(base, "posts");
  ensureDir(postsDir);
  fs.writeFileSync(
    path.join(base, "profile.json"),
    JSON.stringify({ name, bio, created: timestamp }, null, 2)
  );
  fs.writeFileSync(
    path.join(postsDir, "post0.json"),
    JSON.stringify({ timestamp, content: post }, null, 2)
  );
  fs.writeFileSync(
    path.join(base, "status_index.json"),
    JSON.stringify({ posts: ["/posts/post0.json"] }, null, 2)
  );

  const hash = run(`ipfs add -Qr ${base}`);

  // Remove old pins
  try {
    const existingPins = run(`ipfs pin ls --type=recursive`)
      .split("\n")
      .map((line) => line.split(" ")[0])
      .filter((cid) => cid && cid !== hash);

    for (const cid of existingPins) {
      console.log(`🧹 Unpinning old CID: ${cid}`);
      run(`ipfs pin rm ${cid}`);
    }
  } catch (e) {
    console.warn("⚠️ Failed to clean old pins:", e.message);
  }

  const publishOut = run(`ipfs name publish --key=profile /ipfs/${hash}`);
  const ipns = publishOut.split(" ")[2].trim().slice(0, -1);

  console.log("\n✅ Profile live (while script runs):");
  console.log(`📦 IPFS CID: ${hash}`);
  console.log(`🌍 IPNS Address: /ipns/${ipns}`);
  console.log(`🌍 Public Gateway: https://${ipns}.ipns.dweb.link/profile.json`);

  await prompt("\n🔚 Press Enter to stop and export your key...");

  try {
    run(`ipfs key export profile --output="${userKeyFile}"`);
    console.log(`🔐 Key exported to ${userKeyFile}`);
  } catch (e) {
    console.warn("⚠️ Failed to export key:", e.message);
  }

  daemon.kill();
  console.log("🧹 IPFS node shut down.");
}

main();
