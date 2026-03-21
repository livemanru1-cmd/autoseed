import fs from 'fs';
import path from 'path';

const rootDir = process.cwd();
const publicDir = path.join(rootDir, 'public');
const outputPath = path.join(publicDir, 'runtime-config.json');
const examplePath = path.join(publicDir, 'runtime-config.example.json');
const rawConfig = process.env.AUTOSEED_RUNTIME_CONFIG_JSON;

fs.mkdirSync(publicDir, { recursive: true });

if (rawConfig && rawConfig.trim().length > 0) {
  let parsed;
  try {
    parsed = JSON.parse(rawConfig);
  } catch (error) {
    console.error('AUTOSEED_RUNTIME_CONFIG_JSON is not valid JSON.');
    throw error;
  }

  fs.writeFileSync(outputPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  process.exit(0);
}

if (fs.existsSync(outputPath)) {
  process.exit(0);
}

if (fs.existsSync(examplePath)) {
  fs.copyFileSync(examplePath, outputPath);
  process.exit(0);
}

throw new Error(
  'runtime-config.json is missing. Provide AUTOSEED_RUNTIME_CONFIG_JSON or create public/runtime-config.json.'
);

