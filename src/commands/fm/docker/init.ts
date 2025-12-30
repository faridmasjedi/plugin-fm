import * as fs from 'node:fs';
import * as path from 'node:path';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import {
  generateDockerfile,
  generateDockerIgnore,
  generateDockerBuildWorkflow,
  generateDockerReadme,
} from '../../../utils/dockerUtils.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@salesforce/plugin-fm', 'docker.init');

export type DockerInitResult = {
  files: string[];
  outputDir: string;
};

export default class DockerInit extends SfCommand<DockerInitResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'output-dir': Flags.directory({
      char: 'd',
      summary: messages.getMessage('flags.output-dir.summary'),
      default: '.',
    }),
    'base-image': Flags.string({
      char: 'b',
      summary: messages.getMessage('flags.base-image.summary'),
      default: 'node:18-alpine',
    }),
    maintainer: Flags.string({
      char: 'm',
      summary: messages.getMessage('flags.maintainer.summary'),
      default: 'Salesforce DevOps',
    }),
    'sf-cli-version': Flags.string({
      summary: messages.getMessage('flags.sf-cli-version.summary'),
      default: 'latest',
    }),
    'plugin-install-method': Flags.string({
      summary: messages.getMessage('flags.plugin-install-method.summary'),
      options: ['npm', 'local', 'git', 'skip'],
      default: 'npm',
    }),
    'plugin-version': Flags.string({
      summary: messages.getMessage('flags.plugin-version.summary'),
      default: 'latest',
    }),
    'github-workflow': Flags.boolean({
      summary: messages.getMessage('flags.github-workflow.summary'),
      default: true,
      allowNo: true,
    }),
  };

  public async run(): Promise<DockerInitResult> {
    const { flags } = await this.parse(DockerInit);

    const outputDir = path.resolve(flags['output-dir']);

    // Create output directory if it doesn't exist
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const filesCreated: string[] = [];

    // Generate Dockerfile
    const dockerfilePath = path.join(outputDir, 'Dockerfile');
    const dockerfileContent = generateDockerfile({
      baseImage: flags['base-image'],
      maintainer: flags.maintainer,
      sfCliVersion: flags['sf-cli-version'],
      pluginInstallMethod: flags['plugin-install-method'] as 'npm' | 'local' | 'git' | 'skip',
      pluginVersion: flags['plugin-version'],
    });
    fs.writeFileSync(dockerfilePath, dockerfileContent);
    filesCreated.push(dockerfilePath);
    this.log(`Created: ${dockerfilePath}`);

    // Generate .dockerignore
    const dockerignorePath = path.join(outputDir, '.dockerignore');
    const dockerignoreContent = generateDockerIgnore();
    fs.writeFileSync(dockerignorePath, dockerignoreContent);
    filesCreated.push(dockerignorePath);
    this.log(`Created: ${dockerignorePath}`);

    // Generate GitHub workflow if requested
    if (flags['github-workflow']) {
      const workflowDir = path.join(outputDir, '.github', 'workflows');
      if (!fs.existsSync(workflowDir)) {
        fs.mkdirSync(workflowDir, { recursive: true });
      }

      const workflowPath = path.join(workflowDir, 'docker-publish.yml');
      const workflowContent = generateDockerBuildWorkflow();
      fs.writeFileSync(workflowPath, workflowContent);
      filesCreated.push(workflowPath);
      this.log(`Created: ${workflowPath}`);
    }

    // Generate README
    const readmePath = path.join(outputDir, 'DOCKER_README.md');
    const readmeContent = generateDockerReadme({
      baseImage: flags['base-image'],
      maintainer: flags.maintainer,
    });
    fs.writeFileSync(readmePath, readmeContent);
    filesCreated.push(readmePath);
    this.log(`Created: ${readmePath}`);

    this.log('');
    this.log('Docker files generated successfully!');
    this.log('');
    this.log('Next steps:');
    this.log('1. Review and customize the generated Dockerfile');
    this.log('2. Build the image: docker build -t myorg/sf-cicd:latest .');
    this.log('3. Test it: docker run --rm myorg/sf-cicd:latest sf --version');
    this.log('4. See DOCKER_README.md for more usage examples');

    return {
      files: filesCreated,
      outputDir,
    };
  }
}
