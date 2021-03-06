'use strict';

import * as vscode from 'vscode';
import * as solc from 'solc';
import * as fs from 'fs';
import * as path from 'path';
import * as fsExtra from 'fs-extra';
import * as artifactor from 'truffle-artifactor';

import { errorToDiagnostic } from './compilerErrors';
import { DiagnosticSeverity } from 'vscode';

function outputErrorsToChannel(outputChannel: vscode.OutputChannel, errors: any) {
    errors.forEach(error => {
        outputChannel.appendLine(error);
    });

    outputChannel.show();
}

interface ErrorWarningCounts {
    errors: number;
    warnings: number;
}

function outputErrorsToDiagnostics(diagnosticCollection: vscode.DiagnosticCollection, errors: any): ErrorWarningCounts {
    let errorWarningCounts: ErrorWarningCounts = {errors: 0, warnings: 0};
    let diagnosticMap: Map<vscode.Uri, vscode.Diagnostic[]> = new Map();

    errors.forEach(error => {
        let {diagnostic, fileName} = errorToDiagnostic(error);

        let targetUri = vscode.Uri.file(fileName);
        let diagnostics = diagnosticMap.get(targetUri);

        if (!diagnostics) {
            diagnostics = [];
        }

        diagnostics.push(diagnostic);
        diagnosticMap.set(targetUri, diagnostics);
    });

    let entries: [vscode.Uri, vscode.Diagnostic[]][] = [];

    diagnosticMap.forEach((diags, uri) => {
        errorWarningCounts.errors += diags.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.Error).length;
        errorWarningCounts.warnings += diags.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.Warning).length;

        entries.push([uri, diags]);
    });

    diagnosticCollection.set(entries);

    return errorWarningCounts;
}

export function compile(contracts: any,
                        diagnosticCollection: vscode.DiagnosticCollection,
                        buildDir: string, sourceDir: string, excludePath?: string, singleContractFilePath?: string) {
    // Did we find any sol files after all?
    if (Object.keys(contracts).length === 0) {
        vscode.window.showWarningMessage('No solidity files (*.sol) found');
        return;
    }

    let outputChannel = vscode.window.createOutputChannel('Solidity compilation');

    outputChannel.clear();
    outputChannel.show();

    vscode.window.setStatusBarMessage('Compilation started');

    let remoteCompiler = vscode.workspace.getConfiguration('solidity').get('compileUsingRemoteVersion');

    if (typeof remoteCompiler === 'undefined' || remoteCompiler === null) {
        let output = solc.compile({ sources: contracts }, 1);

        processCompilationOuput(output, outputChannel, diagnosticCollection, buildDir, sourceDir, excludePath, singleContractFilePath);
    } else {
       solc.loadRemoteVersion(remoteCompiler, (err, solcSnapshot) => {
            if (err) {
                vscode.window.showWarningMessage('There was an error loading the remote version: ' + remoteCompiler);

                return;
            }

            let output = solcSnapshot.compile({ sources: contracts }, 1);

            processCompilationOuput(output, outputChannel, diagnosticCollection, buildDir,
                                    sourceDir, excludePath, singleContractFilePath);
        });
    }
 }

function processCompilationOuput(output: any, outputChannel: vscode.OutputChannel, diagnosticCollection: vscode.DiagnosticCollection,
                                 buildDir: string, sourceDir: string, excludePath?: string, singleContractFilePath?: string) {
    vscode.window.setStatusBarMessage('Compilation completed');

    if (Object.keys(output).length === 0) {
        vscode.window.showWarningMessage('No output by the compiler');

        return;
    }

    diagnosticCollection.clear();

    if (output.errors) {
        const errorWarningCounts = outputErrorsToDiagnostics(diagnosticCollection, output.errors);

        outputErrorsToChannel(outputChannel, output.errors);

        if (errorWarningCounts.errors > 0) {
            vscode.window.showErrorMessage(`Compilation failed with ${errorWarningCounts.errors} errors`);

            if (errorWarningCounts.warnings > 0) {
                vscode.window.showWarningMessage(`Compilation had ${errorWarningCounts.warnings} warnings`);
            }
        } else if (errorWarningCounts.warnings > 0) {
            writeCompilationOutputToBuildDirectory(output, buildDir, sourceDir, excludePath, singleContractFilePath);

            vscode.window.showWarningMessage(`Compilation had ${errorWarningCounts.warnings} warnings`);
            vscode.window.showInformationMessage('Compilation completed succesfully!');
        }
    } else {
        writeCompilationOutputToBuildDirectory(output, buildDir, sourceDir, excludePath, singleContractFilePath);

        vscode.window.showInformationMessage('Compilation completed succesfully!');
    }
}

function writeCompilationOutputToBuildDirectory(output: any, buildDir: string, sourceDir: string,
                                                excludePath?: string, singleContractFilePath?: string) {
    let binPath = path.join(vscode.workspace.rootPath, buildDir);

    if (!fs.existsSync(binPath)) {
        fs.mkdirSync(binPath);
    }

    function isValid(source) {
        if (!singleContractFilePath || source === singleContractFilePath) {
            if (!excludePath || !source.startsWith(excludePath)) {
                // Output only source directory compilation or all (this will exclude external references)
                if (!sourceDir || source.startsWith(sourceDir)) {
                    return true;
                }
            }
        }
    }

    // iterate through all the sources,
    // find contracts and output them into the same folder structure to avoid collisions, named as the contract
    for (let source in output.sources) {
        if (!isValid(source)) {
            continue;
        }

        output.sources[source].AST.children.forEach(child => {
            if (child.name !== 'Contract' && child.name !== 'ContractDefinition') {
                return;
            }

            let contractName = child.attributes.name;

            let relativePath = path.relative(vscode.workspace.rootPath, source);

            let dirName = path.dirname(path.join(binPath, relativePath));

            if (!fs.existsSync(dirName)) {
                fsExtra.mkdirsSync(dirName);
            }

            let contractAbiPath = path.join(dirName, contractName + '.abi');
            let contractBinPath = path.join(dirName, contractName + '.bin');
            let contractJsonPath = path.join(dirName, contractName + '.json');
            let truffleArtifactPath = path.join(dirName, contractName + '.sol.js');

            if (fs.existsSync(contractAbiPath)) {
                fs.unlinkSync(contractAbiPath);
            }

            if (fs.existsSync(contractBinPath)) {
                fs.unlinkSync(contractBinPath);
            }

            if (fs.existsSync(contractJsonPath)) {
                fs.unlinkSync(contractJsonPath);
            }

            if (fs.existsSync(truffleArtifactPath)) {
                fs.unlinkSync(truffleArtifactPath);
            }

            fs.writeFileSync(contractBinPath, output.contracts[source + ':' + contractName].bytecode);
            fs.writeFileSync(contractAbiPath, output.contracts[source + ':' + contractName].interface);

            let shortJsonOutput = {
                abi: output.contracts[source + ':' + contractName].interface,
                bytecode: output.contracts[source + ':' + contractName].bytecode,
                functionHashes: output.contracts[source + ':' + contractName].functionHashes,
                gasEstimates: output.contracts[source + ':' + contractName].gasEstimates,
                runtimeBytecode: output.contracts[source + ':' + contractName].runtimeBytecode,
            };

            fs.writeFileSync(contractJsonPath, JSON.stringify(shortJsonOutput, null, 4));

            /*
            let contract_data = {
                contract_name: contractName,
                abi: output.contracts[source + ':' + contractName].interface,
                unlinked_binary: output.contracts[source + ':' + contractName].bytecode,
                };

            artifactor.save(contract_data, truffleArtifactPath);
            */
        });
    }
}
