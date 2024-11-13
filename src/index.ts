import { processJavaSource } from './parser';
import { TypeScriptEmitter } from './emitter';
import { downloadMavenArtifact } from './maven';
import type { TypeDefinition } from './types';
import * as fs from 'fs/promises';
import * as path from 'path';
import extract from 'extract-zip';

// Lisää uusi tyyppi artifaktin määrittelyä varten
interface MavenArtifact {
  repository: string;
  artifact: string;
}

const PAPER_REPOSITORY = 'https://repo.papermc.io/repository/maven-public';
async function main() {
  // Korvaa yksittäiset muuttujat artifaktien listalla
  let artifacts: MavenArtifact[] = [
    {
      repository: PAPER_REPOSITORY,
      artifact: 'io.papermc.paper:paper-api:1.21.3-R0.1-SNAPSHOT'
    },
    {
      repository: PAPER_REPOSITORY,
      artifact: 'net.kyori:adventure-api:4.17.0'
    },
    {
      repository: PAPER_REPOSITORY,
      artifact: 'net.kyori:adventure-key:4.17.0'
    },
    {
      repository: PAPER_REPOSITORY,
      artifact: 'net.kyori:adventure-text-serializer-plain:4.17.0'
    },
    {
      repository: PAPER_REPOSITORY,
      artifact: 'net.kyori:adventure-text-serializer-legacy:4.17.0'
    }
    // Tähän voi lisätä muita artifakteja
  ];

  if (process.argv.length > 2) {
    if (!(await Bun.file(process.argv[2]).exists())) {
      console.error(`File ${process.argv[2]} does not exist`);
      process.exit();
    }

    artifacts = (await Bun.file(process.argv[2]).json()) as MavenArtifact[];
  }

  const types = new Map<string, TypeDefinition>();
  const modules = new Map<string, Set<TypeDefinition>>();

  try {
    // Käsittele jokainen artifakti
    for (const {repository, artifact} of artifacts) {
      console.log(`Processing artifact: ${artifact} from ${repository}`);
      
      // Download Maven artifact
      console.log('Downloading Maven artifact...');
      const jarPath = await downloadMavenArtifact(repository, artifact, true);

      // Käytä ./temp hakemistoa extraction directoryna
      const extractDir = path.join('./temp', `extract_${path.basename(jarPath, '.jar')}`);
      await fs.mkdir(extractDir, { recursive: true });
      
      console.log('Extracting JAR to', extractDir);
      await extract(jarPath, { dir: path.resolve(extractDir) });

      console.log('Processing Java files...');
      const files = await processDirectory(extractDir);
      const moduleTypes = await processJavaSource(files);
      
      // Lisää tyypit moduuleihin
      for (const type of moduleTypes) {
        const basePackage = getBasePackage(type.package);
        if (!modules.has(basePackage)) {
          modules.set(basePackage, new Set());
        }
        modules.get(basePackage)!.add(type);
      }

      // Cleanup temporary files
      await fs.rm('./temp', { recursive: true });
    }

    // Generate TypeScript definitions
    console.log('Generating TypeScript definitions...');
    const emitter = new TypeScriptEmitter(types);
    for (const [basePackage, moduleTypes] of modules) {
      const output = emitter.emitPackage(basePackage, Array.from(moduleTypes));
      const OUTPUT_DIR = process.argv.length > 3 ? process.argv[3] : './output';
      const filename = `${OUTPUT_DIR}/${basePackage.replace(/\./g, '_')}.d.ts`;
      if (!(await fs.exists(OUTPUT_DIR))) await fs.mkdir(OUTPUT_DIR, { recursive: true });
      await fs.writeFile(filename, output);
      console.log('Generated', filename);
    }
    
    console.log('Done!');

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }

  async function processDirectory(dir: string) {
    let classes: string[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        classes = classes.concat(await processDirectory(fullPath));
      } else if (entry.name.endsWith('.java')) {
        classes.push(fullPath);
      }
    }

    return classes;
  }
}

function getBasePackage(packageName: string): string {
  const parts = packageName.split('.');
  if (parts.length < 2) return packageName;
  return parts.slice(0, 2).join('.');
}

main().catch(console.error);