// Updated cross-platform IPFS profile script with Windows zip support

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const readline = require("readline");
const { execSync, spawn } = require("child_process");
const { createGunzip } = require("zlib");
const tar = require("tar");
const unzipper = require("unzipper");

const repoRoot = path.join(__dirname, "ipfs-user-profile");
process.env.IPFS_PATH = repoRoot;

const rawPlatform = os.platform();
const platform = rawPlatform === "win32" ? "windows" : rawPlatform; // 👈 FIX
const arch = os.arch() === "x64" ? "amd64" : os.arch();
const isWindows = rawPlatform === "win32";
const fileExt = isWindows ? "zip" : "tar.gz";
const kuboVersion = "v0.35.0";
const kuboURL = `https://dist.ipfs.tech/kubo/${kuboVersion}/kubo_${kuboVersion}_${platform}-${arch}.${fileExt}`;

const localBinDir = path.join(__dirname, "ipfs-bin");
const ipfsCmd = path.join(localBinDir, isWindows ? "ipfs.exe" : "ipfs");
const userKeyFile = path.join(__dirname, "profile.key");

function run(cmd, opts = {}) {
  try {
    const parts = cmd.split(" ");
    const isIpfsCmd = parts[0] === "ipfs";
    const binary = isIpfsCmd ? ipfsCmd : parts[0];
    const args = isIpfsCmd ? parts.slice(1) : parts.slice(1);

    return execSync([binary, ...args].join(" "), {
      stdio: "pipe",
      env: { ...process.env, IPFS_PATH: repoRoot },
      shell: isWindows ? true : undefined,
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
    https
      .get(kuboURL, (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Failed to download: ${res.statusCode}`));
        }
        if (isWindows) {
          res
            .pipe(unzipper.Extract({ path: localBinDir }))
            .on("close", resolve)
            .on("error", reject);
        } else {
          res
            .pipe(createGunzip())
            .pipe(tar.x({ cwd: localBinDir, strip: 1 }))
            .on("finish", resolve)
            .on("error", reject);
        }
      })
      .on("error", reject);
  });

  const finalPath = ipfsCmd;
  if (!fs.existsSync(finalPath)) {
    const sub = path.join(localBinDir, "kubo");
    const ipfsBinary = fs
      .readdirSync(sub)
      .find((f) => f === (isWindows ? "ipfs.exe" : "ipfs"));
    if (ipfsBinary) {
      fs.copyFileSync(path.join(sub, ipfsBinary), finalPath);
      if (!isWindows) fs.chmodSync(finalPath, 0o755);
    } else {
      throw new Error("ipfs binary not found in downloaded archive.");
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
    run(`ipfs key import profile \"${userKeyFile}\"`);
  } else {
    console.log("🆕 Generating new IPNS key 'profile'...");
    run("ipfs key gen profile --type=rsa --size=2048");
  }
}

async function main() {
  if (!checkIPFS()) {
    await downloadAndInstallIPFS();
  }

  initIPFSRepo();
  importUserKey();

  console.log("🚀 Starting IPFS node...");
  const daemon = spawn(ipfsCmd, ["daemon"], {
    env: { ...process.env, IPFS_PATH: repoRoot },
    stdio: "inherit",
    shell: isWindows,
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

  const hash = run(`ipfs add -Qr --cid-version=1 --raw-leaves \"${base}\"`);

  // Clean up old pins
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
  const ipns = publishOut.split(" ")[2].trim().replace(/\/$/, "");

  console.log("\n✅ Profile live (while script runs):");
  console.log(`📦 IPFS CID: ${hash}`);
  console.log(`🌍 IPNS Address: /ipns/${ipns}`);
  console.log(`🌍 Public Gateway: https://${ipns}.ipns.dweb.link/profile.json`);

  await prompt("\n🔚 Press Enter to stop and export your key...");

  try {
    run(`ipfs key export profile --output=\"${userKeyFile}\"`);
    console.log(`🔐 Key exported to ${userKeyFile}`);
  } catch (e) {
    console.warn("⚠️ Failed to export key:", e.message);
  }

  daemon.kill();
  console.log("🧹 IPFS node shut down.");
}

main();
