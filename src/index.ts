import { processJavaSource } from './parser';
import { TypeScriptEmitter } from './emitter';
import { downloadMavenArtifact } from './maven';
import type { TypeDefinition } from './types';
import * as fs from 'fs/promises';
import * as path from 'path';
import extract from 'extract-zip';

// Laajennetaan tyyppiä tukemaan ZIP-tiedostoja
interface ArtifactSource {
  type: 'maven' | 'zip';
  repository?: string;  // Vain Maven-artifakteille
  artifact?: string;    // Vain Maven-artifakteille
  zipPath?: string;     // Vain ZIP-tiedostoille
  include?: string[];
  exclude?: string[];
  offset?: string;
}

const PAPER_REPOSITORY = 'https://repo.papermc.io/repository/maven-public';
async function main() {
  // Esimerkki konfiguraatio, joka tukee molempia tyyppejä
  let artifacts: ArtifactSource[] = [
    {
      type: 'maven',
      repository: PAPER_REPOSITORY,
      artifact: 'io.papermc.paper:paper-api:1.21.3-R0.1-SNAPSHOT'
    },
    {
      type: 'maven',
      repository: PAPER_REPOSITORY,
      artifact: 'net.kyori:adventure-api:4.17.0'
    },
    {
      type: 'maven',
      repository: PAPER_REPOSITORY,
      artifact: 'net.kyori:adventure-key:4.17.0'
    },
    {
      type: 'maven',
      repository: PAPER_REPOSITORY,
      artifact: 'net.kyori:adventure-text-serializer-plain:4.17.0'
    },
    {
      type: 'maven',
      repository: PAPER_REPOSITORY,
      artifact: 'net.kyori:adventure-text-serializer-legacy:4.17.0'
    }
  ];

  if (process.argv.length > 2) {
    if (!(await Bun.file(process.argv[2]).exists())) {
      console.error(`File ${process.argv[2]} does not exist`);
      process.exit(1);
    }
    artifacts = (await Bun.file(process.argv[2]).json()) as ArtifactSource[];
  }

  const types = new Map<string, TypeDefinition>();
  const modules = new Map<string, Set<TypeDefinition>>();

  try {
    for (const artifactSource of artifacts) {
      let extractDir: string;
      
      if (artifactSource.type === 'maven') {
        if (!artifactSource.repository || !artifactSource.artifact) {
          throw new Error('Maven artifact requires repository and artifact fields');
        }
        
        console.log(`Processing Maven artifact: ${artifactSource.artifact} from ${artifactSource.repository}`);
        const jarPath = await downloadMavenArtifact(artifactSource.repository, artifactSource.artifact, true);
        
        extractDir = path.join('./temp', `extract_${path.basename(jarPath, '.jar')}`);
        await fs.mkdir(extractDir, { recursive: true });
        
        console.log('Extracting JAR to', extractDir);
        await extract(jarPath, { dir: path.resolve(extractDir) });
        
        // Cleanup JAR after extraction
        await fs.rm(jarPath);
      } else if (artifactSource.type === 'zip') {
        if (!artifactSource.zipPath) {
          throw new Error('ZIP source requires zipPath field');
        }
        
        if (!(await fs.exists(artifactSource.zipPath))) {
          throw new Error(`ZIP file not found: ${artifactSource.zipPath}`);
        }

        console.log(`Processing ZIP file: ${artifactSource.zipPath}`);
        extractDir = path.join('./temp', `extract_${path.basename(artifactSource.zipPath, '.zip')}`);
        await fs.mkdir(extractDir, { recursive: true });
        
        console.log('Extracting ZIP to', extractDir);
        await extract(artifactSource.zipPath, { dir: path.resolve(extractDir) });
      } else {
        throw new Error(`Unknown artifact type: ${(artifactSource as any).type}`);
      }

      if (artifactSource.offset) {
        extractDir = path.join(extractDir, artifactSource.offset);
      }

      console.log('Processing Java files...');
      const files = await processDirectory(extractDir, artifactSource, extractDir);
      const moduleTypes = await processJavaSource(files);
      
      // Lisää tyypit moduuleihin
      for (const type of moduleTypes) {
        const basePackage = getBasePackage(type.package);
        if (!modules.has(basePackage)) {
          modules.set(basePackage, new Set());
        }
        modules.get(basePackage)!.add(type);
      }

      // Cleanup extracted files
      await fs.rm(extractDir, { recursive: true });
    }

    // Generate TypeScript definitions
    console.log('Generating TypeScript definitions...');
    const emitter = new TypeScriptEmitter();
    const files = [];
    const OUTPUT_DIR = process.argv.length > 3 ? process.argv[3] : './output';
    const all = Array.from(modules.values()).map((i) => Array.from<TypeDefinition>(i)).flat();
    for (const [basePackage, moduleTypes] of modules) {
      const output = emitter.emitPackage(basePackage, Array.from(moduleTypes), all);
      const filename = `${OUTPUT_DIR}/${basePackage.replace(/\./g, '_')}.d.ts`;
      if (!(await fs.exists(OUTPUT_DIR))) await fs.mkdir(OUTPUT_DIR, { recursive: true });
      await fs.writeFile(filename, output);
      files.push(`${basePackage.replace(/\./g, '_')}.d.ts`);
      console.log('Generated', filename);
    }

    // Generate index.d.ts with references
    await fs.writeFile(`${OUTPUT_DIR}/index.d.ts`, `// Auto generated index file, do not edit!\n\n${files.map((i) => `/// <reference path="${i}" />`).join('\n')}`);
    
    console.log('Done!');

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }

  // Lisää apufunktio polun muuntamiseen paketiksi
  function pathToPackage(filePath: string, extractDir: string): string {
    const relativePath = path.relative(extractDir, filePath);
    
    return relativePath
      .replace(/\.java$/, '')
      .split(path.sep)
      .join('.');
  }

  async function processDirectory(dir: string, artifactSource: ArtifactSource, originalDir: string) {
    let classes: string[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        classes = classes.concat(await processDirectory(fullPath, artifactSource, originalDir));
      } else if (entry.name.endsWith('.java')) {
        const packageName = pathToPackage(fullPath, originalDir);
        
        // Tarkista onko paketti sallittujen lilla
        if (isPackageAllowed(packageName, artifactSource.include, artifactSource.exclude)) {
          classes.push(fullPath);
        }
      }
    }

    return classes;
  }

  function getBasePackage(packageName: string): string {
    const parts = packageName.split('.');
    if (parts.length < 2) return packageName;
    return parts.slice(0, 2).join('.');
  }

  function isPackageAllowed(packageName: string, include?: string[], exclude?: string[]): boolean {
    if (include) {
      let allowed = false;
      for (const includePackage of include) {
        if (packageName.startsWith(includePackage)) {
          allowed = true;
          break;
        }
      }
      if (!allowed) return false;      
    }
    if (exclude) {
      for (const excludePackage of exclude) {
        if (packageName.startsWith(excludePackage)) {
          return false;
        }
      }
    }
    return true;
  }
}

main().catch(console.error);