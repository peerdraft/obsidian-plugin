import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { createInterface } from 'readline/promises';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to execute shell commands
const runCommand = (command) => {
  console.log(`Running: ${command}`);
  execSync(command, { stdio: "inherit" });
};

// Helper to get current git branch
const getCurrentBranch = () => {
  return execSync('git branch --show-current', { encoding: 'utf8' }).trim();
};

// Helper to update JSON files
const updateJsonFile = (filePath, updateFn) => {
  const json = JSON.parse(readFileSync(filePath, "utf8"));
  updateFn(json);
  writeFileSync(filePath, JSON.stringify(json, null, 2));
  console.log(`Updated: ${filePath}`);
};

// Calculate the next version based on bump type and optional pre-release
const getNextVersion = (currentVersion, bumpType, preReleaseType = null, preReleaseNumber = null) => {
  let [major, minor, patch] = currentVersion.split(".").map(Number);

  switch (bumpType.toLowerCase()) {
    case 'major':
      major += 1;
      minor = 0;
      patch = 0;
      break;
    case 'minor':
      minor += 1;
      patch = 0;
      break;
    case 'patch':
      patch += 1;
      break;
    default:
      throw new Error(`Invalid bump type: ${bumpType}. Must be 'major', 'minor', or 'patch'`);
  }

  const baseVersion = `${major}.${minor}.${patch}`;
  if (preReleaseType && preReleaseNumber !== null) {
    return `${baseVersion}-${preReleaseType}.${preReleaseNumber}`;
  }
  return baseVersion;
};

// Paths to files
const packageJsonPath = path.resolve("package.json");
const manifestJsonPath = path.resolve("manifest.json");
const distManifestJsonPath = path.resolve("dist/manifest.json");
const versionsJsonPath = path.resolve("versions.json");

// Prompt user for bump type
const promptBumpType = async () => {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const answer = await rl.question('Enter version bump type (major/minor/patch): ');
    return answer.trim().toLowerCase();
  } finally {
    rl.close();
  }
};

// Prompt user for release type (stable vs pre-release)
const promptReleaseType = async () => {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const answer = await rl.question('Is this a stable release or pre-release? (stable/pre): ');
    const releaseType = answer.trim().toLowerCase();
    if (releaseType === 'pre' || releaseType === 'prerelease') {
      return 'pre';
    }
    return 'stable';
  } finally {
    rl.close();
  }
};

// Prompt user for pre-release type
const promptPreReleaseType = async () => {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const answer = await rl.question('Enter pre-release type (alpha/beta/rc): ');
    return answer.trim().toLowerCase();
  } finally {
    rl.close();
  }
};

// Prompt user for pre-release number
const promptPreReleaseNumber = async () => {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const answer = await rl.question('Enter pre-release number (e.g., 1, 2, 3): ');
    return parseInt(answer.trim(), 10);
  } finally {
    rl.close();
  }
};

// Main function
const main = async () => {
  try {
    // Check current branch
    const currentBranch = getCurrentBranch();
    console.log(`Current branch: ${currentBranch}`);

    // Get release type from user
    const releaseType = await promptReleaseType();
    console.log(`Release type: ${releaseType}`);

    // Validate branch based on release type
    if (releaseType === 'stable' && currentBranch !== 'main') {
      console.error('Error: Stable releases must be created from the main branch. Current branch:', currentBranch);
      process.exit(1);
    }
    if (releaseType === 'pre' && currentBranch !== 'pre') {
      console.error('Error: Pre-releases must be created from the pre branch. Current branch:', currentBranch);
      process.exit(1);
    }

    // Get bump type from user
    const bumpType = await promptBumpType();
    if (!['major', 'minor', 'patch'].includes(bumpType)) {
      console.error('Error: Invalid bump type. Must be one of: major, minor, patch');
      process.exit(1);
    }

    // For pre-releases, get pre-release type and number
    let preReleaseType = null;
    let preReleaseNumber = null;
    if (releaseType === 'pre') {
      preReleaseType = await promptPreReleaseType();
      if (!['alpha', 'beta', 'rc'].includes(preReleaseType)) {
        console.error('Error: Invalid pre-release type. Must be one of: alpha, beta, rc');
        process.exit(1);
      }
      preReleaseNumber = await promptPreReleaseNumber();
      if (isNaN(preReleaseNumber) || preReleaseNumber < 1) {
        console.error('Error: Invalid pre-release number. Must be a positive integer');
        process.exit(1);
      }
    }

    // Step 1: Read the current version from package.json
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const currentVersion = packageJson.version;
    const nextVersion = getNextVersion(currentVersion, bumpType, preReleaseType, preReleaseNumber);

    console.log(`Bumping version from ${currentVersion} to ${nextVersion} (${bumpType} bump${releaseType === 'pre' ? `, ${preReleaseType}.${preReleaseNumber}` : ''})`);

    // Step 2: Update package.json
    updateJsonFile(packageJsonPath, (json) => {
      json.version = nextVersion;
    });

    // Step 3: Update manifest.json and dist/manifest.json
    [manifestJsonPath, distManifestJsonPath].forEach((file) => {
      updateJsonFile(file, (json) => {
        json.version = nextVersion;
      });
    });

    // Step 4: Update versions.json
    const manifestJson = JSON.parse(readFileSync(manifestJsonPath, "utf8"));
    const minAppVersion = manifestJson.minAppVersion;

    updateJsonFile(versionsJsonPath, (json) => {
      json[nextVersion] = minAppVersion;
    });

    // Step 5: Run npm install and build
    runCommand("npm i");
    runCommand("npm run build");

    // Step 6: Commit and tag the version
    runCommand(`git add .`);
    runCommand(`git commit -m "chore: bump ${bumpType} version to ${nextVersion}"`);
    runCommand(`git tag -a ${nextVersion} -m "Version ${nextVersion}"`);
    runCommand("git push");
    runCommand("git push --tags");
    // Step 11: Create a new release in GitHub
    const releaseFiles = ["dist/main.js", "dist/manifest.json", "dist/styles.css"];
    const releaseFilesArgs = releaseFiles.map((file) => `${file}`).join(" ");
    const preReleaseFlag = releaseType === 'pre' ? '--pre-release' : '';
    runCommand(
      `gh release create ${nextVersion} ${releaseFilesArgs} -t "${nextVersion}" --generate-notes ${preReleaseFlag}`
    );

    console.log(`Version bumped to ${nextVersion} and release created.`);
  } catch (error) {
    console.error('Error during version bump:', error.message);
    process.exit(1);
  }
};

// Run the main function
main()

