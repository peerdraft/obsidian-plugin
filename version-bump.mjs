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

// Helper to update JSON files
const updateJsonFile = (filePath, updateFn) => {
  const json = JSON.parse(readFileSync(filePath, "utf8"));
  updateFn(json);
  writeFileSync(filePath, JSON.stringify(json, null, 2));
  console.log(`Updated: ${filePath}`);
};

// Calculate the next version based on bump type
const getNextVersion = (currentVersion, bumpType) => {
  let [major, minor, patch] = currentVersion.split(".").map(Number);

  switch (bumpType.toLowerCase()) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`Invalid bump type: ${bumpType}. Must be 'major', 'minor', or 'patch'`);
  }
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

// Main function
const main = async () => {
  try {
    // Get bump type from user
    const bumpType = await promptBumpType();
    if (!['major', 'minor', 'patch'].includes(bumpType)) {
      console.error('Error: Invalid bump type. Must be one of: major, minor, patch');
      process.exit(1);
    }

    // Step 1: Read the current version from package.json
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const currentVersion = packageJson.version;
    const nextVersion = getNextVersion(currentVersion, bumpType);

    console.log(`Bumping version from ${currentVersion} to ${nextVersion} (${bumpType} bump)`);

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
    runCommand(`git tag -a v${nextVersion} -m "Version ${nextVersion}"`);
    runCommand("git push");
    runCommand("git push --tags");
    // Step 11: Create a new release in GitHub
    const releaseFiles = ["dist/main.js", "dist/manifest.json", "dist/styles.css"];
    const releaseFilesArgs = releaseFiles.map((file) => `${file}`).join(" ");
    runCommand(
      `gh release create ${nextVersion} ${releaseFilesArgs} -t "${nextVersion}" --generate-notes`
    );

    console.log(`Version bumped to ${nextVersion} and release created.`);
  } catch (error) {
    console.error('Error during version bump:', error.message);
    process.exit(1);
  }
};

// Run the main function
main()

