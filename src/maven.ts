import fetch from 'node-fetch';
import * as fs from 'fs/promises';
import * as path from 'path';
import { XMLParser } from 'fast-xml-parser';

interface MavenMetadata {
    metadata: {
        versioning: {
            snapshot: {
                timestamp: string;
                buildNumber: string;
            };
            snapshotVersions?: {
                snapshotVersion: Array<{
                    extension: string;
                    value: string;
                    updated: string;
                }>;
            };
            lastUpdated: string;
        };
    };
}

async function getSnapshotVersion(
    mavenRepo: string,
    groupId: string,
    artifactId: string,
    version: string
): Promise<string> {
    const metadataUrl = `${mavenRepo}/${groupId.replace(/\./g, '/')}/${artifactId}/${version}/maven-metadata.xml`;
    console.log(`Fetching maven metadata from: ${metadataUrl}`);
    
    const response = await fetch(metadataUrl);
    if (!response.ok) {
        throw new Error(`Failed to fetch maven metadata: ${response.statusText}`);
    }

    const xmlText = await response.text();
    const parser = new XMLParser();
    const metadata = parser.parse(xmlText) as MavenMetadata;

    const timestamp = metadata.metadata.versioning.snapshot.timestamp;
    const buildNumber = metadata.metadata.versioning.snapshot.buildNumber;
    
    // Convert SNAPSHOT to timestamp-buildNumber format
    const snapshotVersion = version.replace('SNAPSHOT', `${timestamp}-${buildNumber}`);
    console.log(`Resolved SNAPSHOT version: ${snapshotVersion}`);
    
    return snapshotVersion;
}

export async function downloadMavenArtifact(
  repo: string,
  coordinates: string,
  sources: boolean = false
): Promise<string> {
  const [group, artifact, version] = coordinates.split(':');
  const groupPath = group.replace(/\./g, '/');
  
  let jarVersion = version;
  if (version.includes('SNAPSHOT')) {
    jarVersion = await getSnapshotVersion(repo, group, artifact, version);
  }

  // Muodosta URL
  const filename = sources ? 
    `${artifact}-${jarVersion}-sources.jar` :
    `${artifact}-${jarVersion}.jar`;
    
  const url = `${repo}/${groupPath}/${artifact}/${version}/${filename}`;

  // Luo ./temp hakemisto jos sitä ei ole
  await fs.mkdir('./temp', { recursive: true });

  // Lataa tiedosto
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download: ${response.statusText}`);
  }

  // Tallenna tiedosto ./temp hakemistoon
  const jarPath = path.join('./temp', filename);
  
  await fs.writeFile(jarPath, await response.buffer());
  return jarPath;
} 