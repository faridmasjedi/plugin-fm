/*
 * Copyright 2024, Salesforce, Inc.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted permitted that the following conditions are met:
 *
 * 1. Redistributions of code must retain the above copyright notice,
 *    this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import { DEFAULT_PIPELINE_FILES, loadPipelineConfig } from '../../utils/pipeline/config.js';
import { DEFAULT_RUNS_DIR, RunStore } from '../../utils/pipeline/store.js';
import { findFirstExisting } from '../../utils/qualityUtils.js';
import { renderStaticDashboard, startDashboardServer } from '../../utils/dashboard/server.js';

Messages.importMessagesDirectoryFromMetaUrl(new URL('../../../messages', import.meta.url).toString());
const messages = Messages.loadMessages('@salesforce/plugin-fm', 'dashboard');

export type DashboardResult = { url?: string; exported?: string; runs: number };

export default class Dashboard extends SfCommand<DashboardResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    port: Flags.integer({
      char: 'p',
      summary: messages.getMessage('flags.port.summary'),
      default: 7007,
    }),
    export: Flags.file({
      char: 'e',
      summary: messages.getMessage('flags.export.summary'),
    }),
    open: Flags.boolean({
      summary: messages.getMessage('flags.open.summary'),
      default: false,
    }),
    file: Flags.file({
      char: 'f',
      summary: messages.getMessage('flags.file.summary'),
      exists: true,
    }),
    'runs-dir': Flags.directory({
      summary: messages.getMessage('flags.runsDir.summary'),
      default: DEFAULT_RUNS_DIR,
    }),
  };

  public async run(): Promise<DashboardResult> {
    const { flags } = await this.parse(Dashboard);
    const cwd = process.cwd();
    const store = new RunStore(cwd, flags['runs-dir']);
    const configPath = flags.file ? resolve(cwd, flags.file) : findFirstExisting(cwd, DEFAULT_PIPELINE_FILES);
    let pipelineName: string | undefined;
    if (configPath) {
      try {
        pipelineName = loadPipelineConfig(configPath).name;
      } catch (error) {
        this.warn((error as Error).message);
      }
    }

    if (flags.export) {
      const out = resolve(cwd, flags.export);
      writeFileSync(out, renderStaticDashboard(store, { pipelineName, configPath }, cwd));
      this.log(messages.getMessage('info.exported', [out, store.list().length.toString()]));
      return { exported: out, runs: store.list().length };
    }

    // The dashboard starts runs with this same plugin binary
    const startCommand =
      configPath && pipelineName
        ? [
            process.execPath,
            join(this.config.root, 'bin', 'run.js'),
            'fm',
            'pipeline',
            'run',
            '--file',
            configPath,
            '--runs-dir',
            flags['runs-dir'],
          ]
        : undefined;

    await startDashboardServer({
      store,
      port: flags.port,
      cwd,
      pipelineName,
      configPath,
      startCommand,
      pluginCommand: [process.execPath, join(this.config.root, 'bin', 'run.js')],
      runsDir: flags['runs-dir'],
      user: userInfo().username,
    });
    const url = `http://127.0.0.1:${flags.port}`;
    this.log(messages.getMessage('info.serving', [url]));
    if (flags.open) {
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      spawn(opener, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
    }

    // Keep serving until the user stops the command
    await new Promise<void>((resolveWait) => process.once('SIGINT', () => resolveWait()));
    return { url, runs: store.list().length };
  }
}
