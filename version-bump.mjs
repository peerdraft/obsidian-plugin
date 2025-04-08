import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import path from "path";

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

// Calculate the next minor version
const getNextMinorVersion = (currentVersion) => {
  const [major, minor] = currentVersion.split(".").map(Number);
  return `${major}.${minor + 1}.0`;
};

// Paths to files
const packageJsonPath = path.resolve("package.json");
const manifestJsonPath = path.resolve("manifest.json");
const distManifestJsonPath = path.resolve("dist/manifest.json");
const versionsJsonPath = path.resolve("versions.json");

// Step 1: Read the current version from package.json
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const currentVersion = packageJson.version;
const nextVersion = getNextMinorVersion(currentVersion);

console.log(`Bumping version from ${currentVersion} to ${nextVersion}`);

// Step 2: Update package.json
updateJsonFile(packageJsonPath, (json) => {
  json.version = nextVersion;
});

// Step 3: Update manifest.json
updateJsonFile(manifestJsonPath, (json) => {
  json.version = nextVersion;
});

// Step 4: Update dist/manifest.json
updateJsonFile(distManifestJsonPath, (json) => {
  json.version = nextVersion;
});

// Step 5: Add new version to versions.json
const manifestJson = JSON.parse(readFileSync(manifestJsonPath, "utf8"));
const minAppVersion = manifestJson.minAppVersion;

updateJsonFile(versionsJsonPath, (json) => {
  json[nextVersion] = minAppVersion;
});

// Step 6: Run npm install
runCommand("npm i");

// Step 7: Run npm build
runCommand("npm run build");

// Step 8: Commit the changes
runCommand(`git add .`);
runCommand(`git commit -m "bump version to ${nextVersion}"`);

// Step 9: Create a tag
runCommand(`git tag ${nextVersion}`);

// Step 10: Push changes and tag to origin
runCommand("git push");
runCommand("git push --tags");

// Step 11: Create a new release in GitHub
const releaseFiles = ["dist/main.js", "dist/manifest.json", "dist/styles.css"];
const releaseFilesArgs = releaseFiles.map((file) => `${file}`).join(" ");
runCommand(
  `gh release create ${nextVersion} ${releaseFilesArgs} -t "${nextVersion}" --generate-notes`
);

console.log(`Version bumped to ${nextVersion} and release created.`);