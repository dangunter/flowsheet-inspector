import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { reloadAllWebviews } from './reload_window';

const REBUILD_DELAY_MS = 250;

interface DebouncedJob extends vscode.Disposable {
    schedule(): void;
}

/**
 * Starts the source rebuild loop used by an Extension Development Host.
 *
 * The backend cannot safely replace its own loaded CommonJS modules, so a
 * successful backend build restarts only the Extension Host process. The VS
 * Code development window remains open. Webviews can load a rebuilt bundle by
 * assigning fresh HTML, so they do not need an Extension Host restart.
 */
export function startDevHotReload(context: vscode.ExtensionContext): vscode.Disposable {
    if (context.extensionMode !== vscode.ExtensionMode.Development) {
        return new vscode.Disposable(() => undefined);
    }

    const output = vscode.window.createOutputChannel('Flowsheet Inspector Dev Reload');
    const extensionSource = vscode.Uri.joinPath(context.extensionUri, 'src');
    const webviewRoot = vscode.Uri.joinPath(context.extensionUri, '..', 'webview_ui');
    const webviewSource = vscode.Uri.joinPath(webviewRoot, 'src');

    const extensionJob = createDebouncedJob(async () => {
        output.appendLine('[extension] Compiling changed TypeScript...');
        const tscPath = path.join(context.extensionPath, 'node_modules', 'typescript', 'bin', 'tsc');
        const built = await runNodeTool(tscPath, ['-p', context.extensionPath], context.extensionPath, output);
        if (!built) {
            output.appendLine('[extension] Build failed; keeping the current Extension Host running.');
            output.show(true);
            return;
        }

        output.appendLine('[extension] Build complete; restarting the Extension Host...');
        await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
    });

    const webviewJob = createDebouncedJob(async () => {
        output.appendLine('[webview] Building changed React source...');
        const webviewPath = webviewRoot.fsPath;
        const tscPath = path.join(webviewPath, 'node_modules', 'typescript', 'bin', 'tsc');
        const vitePath = path.join(webviewPath, 'node_modules', 'vite', 'bin', 'vite.js');

        const typechecked = await runNodeTool(tscPath, ['-b'], webviewPath, output);
        if (!typechecked) {
            output.appendLine('[webview] TypeScript build failed; keeping the current webview bundle.');
            output.show(true);
            return;
        }

        const bundled = await runNodeTool(vitePath, ['build'], webviewPath, output);
        if (!bundled) {
            output.appendLine('[webview] Vite build failed; keeping the current webview bundle.');
            output.show(true);
            return;
        }

        const reloaded = reloadAllWebviews(context);
        output.appendLine(`[webview] Build complete; reloaded ${reloaded} active webview(s).`);
    });

    const extensionWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(extensionSource, '**/*.ts')
    );
    const webviewWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(webviewSource, '**/*')
    );

    watchAllChanges(extensionWatcher, extensionJob);
    watchAllChanges(webviewWatcher, webviewJob);
    output.appendLine('[dev reload] Watching extension/src and webview_ui/src.');

    return vscode.Disposable.from(
        extensionWatcher,
        webviewWatcher,
        extensionJob,
        webviewJob,
        output
    );
}

function watchAllChanges(watcher: vscode.FileSystemWatcher, job: DebouncedJob) {
    watcher.onDidChange(() => job.schedule());
    watcher.onDidCreate(() => job.schedule());
    watcher.onDidDelete(() => job.schedule());
}

function createDebouncedJob(action: () => Promise<void>): DebouncedJob {
    let timer: NodeJS.Timeout | undefined;
    let running = false;
    let queued = false;
    let disposed = false;

    const run = async () => {
        if (running) {
            queued = true;
            return;
        }

        running = true;
        try {
            do {
                queued = false;
                await action();
            } while (queued && !disposed);
        } catch (error) {
            console.error(`Development reload failed: ${error instanceof Error ? error.stack : String(error)}`);
        } finally {
            running = false;
        }
    };

    return {
        schedule() {
            if (disposed) {
                return;
            }
            if (timer) {
                clearTimeout(timer);
            }
            timer = setTimeout(() => {
                timer = undefined;
                void run();
            }, REBUILD_DELAY_MS);
        },
        dispose() {
            disposed = true;
            if (timer) {
                clearTimeout(timer);
            }
        }
    };
}

function runNodeTool(
    scriptPath: string,
    args: string[],
    cwd: string,
    output: vscode.OutputChannel
): Promise<boolean> {
    if (!fs.existsSync(scriptPath)) {
        output.appendLine(`Build tool not found: ${scriptPath}. Run npm install in the relevant directory.`);
        return Promise.resolve(false);
    }

    return new Promise((resolve) => {
        // VS Code's executable runs Node scripts when ELECTRON_RUN_AS_NODE is
        // set, avoiding shell-specific npm.cmd quoting on Windows.
        const child = spawn(process.execPath, [scriptPath, ...args], {
            cwd,
            windowsHide: true,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
        });

        child.stdout.on('data', (chunk: Buffer) => output.append(chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => output.append(chunk.toString()));
        child.on('error', (error) => {
            output.appendLine(`Failed to start build tool: ${error.message}`);
            resolve(false);
        });
        child.on('close', (code) => resolve(code === 0));
    });
}
