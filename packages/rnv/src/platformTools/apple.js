/* eslint-disable import/no-cycle */
// @todo fix circular dep
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import child_process from 'child_process';
import { executeAsync } from '../systemTools/exec';
import { createPlatformBuild } from '../cli/platform';
import {
    logTask,
    logError,
    logWarning,
    getAppFolder,
    isPlatformActive,
    logDebug,
    getAppVersion,
    getAppTitle,
    getEntryFile,
    writeCleanFile,
    getAppTemplateFolder,
    getAppId,
    copyBuildsFolder,
    getConfigProp,
    getIP,
    getQuestion,
    logSuccess,
} from '../common';
import { IOS, TVOS } from '../constants';
import { copyFolderContentsRecursiveSync, copyFileSync, mkdirSync } from '../systemTools/fileutils';
import { getMergedPlugin } from '../pluginTools';

const xcode = require('xcode');
const readline = require('readline');

const checkIfCommandExists = command => new Promise((resolve, reject) => child_process.exec(`command -v ${command} 2>/dev/null`, (error) => {
    if (error) return reject(new Error(`${command} not installed`));
    return resolve();
}));

const runPod = (command, cwd, rejectOnFail = false) => new Promise((resolve, reject) => {
    logTask(`runPod:${command}`);

    if (!fs.existsSync(cwd)) {
        logError(`Location ${cwd} does not exists!`);
        if (rejectOnFail) return reject();
        return resolve();
    }
    return checkIfCommandExists('pod')
        .then(() => executeAsync('pod', [command], {
            cwd,
            evn: process.env,
            stdio: 'inherit',
        })
            .then(() => resolve())
            .catch((e) => {
                logError(e);
                if (rejectOnFail) return reject(e);
                return resolve();
            }))
        .catch(err => logError(err));
});

const copyAppleAssets = (c, platform, appFolderName) => new Promise((resolve) => {
    logTask('copyAppleAssets');
    if (!isPlatformActive(c, platform, resolve)) return;

    const iosPath = path.join(getAppFolder(c, platform), appFolderName);
    const sPath = path.join(c.paths.appConfigFolder, `assets/${platform}`);
    copyFolderContentsRecursiveSync(sPath, iosPath);
    resolve();
});

const runXcodeProject = (c, platform, target) => new Promise((resolve, reject) => {
    logTask(`runXcodeProject:${platform}:${target}`);

    if (target === '?') {
        launchAppleSimulator(c, platform, target).then((newTarget) => {
            _runXcodeProject(c, platform, newTarget)
                .then(() => resolve())
                .catch(e => reject(e));
        });
    } else {
        _runXcodeProject(c, platform, target)
            .then(() => resolve())
            .catch(e => reject(e));
    }
});

const _runXcodeProject = (c, platform, target) => new Promise((resolve, reject) => {
    logTask(`_runXcodeProject:${platform}:${target}`);

    const appPath = getAppFolder(c, platform);
    const { device } = c.program;
    const scheme = getConfigProp(c, platform, 'scheme');
    const runScheme = getConfigProp(c, platform, 'runScheme');
    const bundleIsDev = getConfigProp(c, platform, 'bundleIsDev') === true;
    const bundleAssets = getConfigProp(c, platform, 'bundleAssets') === true;
    let p;

    if (!scheme) {
        reject(
            `You missing scheme in platforms.${chalk.yellow(platform)} in your ${chalk.white(
                c.paths.appConfigPath,
            )}! Check example config for more info:  ${chalk.blue(
                'https://github.com/pavjacko/renative/blob/master/appConfigs/helloWorld/config.json',
            )} `,
        );
        return;
    }

    if (device === true) {
        const devicesArr = _getAppleDevices(c, platform, false, true);
        if (devicesArr.length === 1) {
            logSuccess(`Found one device connected! ${chalk.white(devicesArr[0].name)}`);
            p = [
                'run-ios',
                '--project-path',
                appPath,
                '--device',
                devicesArr[0].name,
                '--scheme',
                scheme,
                '--configuration',
                runScheme,
            ];
        } else if (devicesArr.length > 1) {
            let devicesString = '\n';
            devicesArr.forEach((v, i) => {
                devicesString += `-[${i + 1}] ${chalk.white(v.name)} | ${v.deviceIcon} | v: ${chalk.green(v.version)} | udid: ${chalk.blue(
                    v.udid,
                )}${v.isDevice ? chalk.red(' (device)') : ''}\n`;
            });

            const readlineInterface = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
            });
            readlineInterface.question(getQuestion(`${devicesString}\nType number of the device you want to launch`), (v) => {
                const selectedDevice = devicesArr[parseInt(v, 10) - 1];
                if (selectedDevice) {
                    p = [
                        'run-ios',
                        '--project-path',
                        appPath,
                        '--device',
                        selectedDevice.name,
                        '--scheme',
                        scheme,
                        '--configuration',
                        runScheme,
                    ];
                    if (bundleAssets) {
                        packageBundleForXcode(c, platform, bundleIsDev)
                            .then(v => executeAsync('react-native', p))
                            .then(() => resolve())
                            .catch(e => reject(e));
                    } else {
                        executeAsync('react-native', p)
                            .then(() => resolve())
                            .catch(e => reject(e));
                    }
                } else {
                    reject(`Wrong choice ${v}! Ingoring`);
                }
            });
            return;
        } else {
            reject(`No ${platform} devices connected!`);
            return;
        }
    } else if (device) {
        p = ['run-ios', '--project-path', appPath, '--device', device, '--scheme', scheme, '--configuration', runScheme];
    } else {
        p = ['run-ios', '--project-path', appPath, '--simulator', target, '--scheme', scheme, '--configuration', runScheme];
    }

    logDebug('running', p);
    if (p) {
        if (bundleAssets) {
            packageBundleForXcode(c, platform, bundleIsDev)
                .then(v => executeAsync('react-native', p))
                .then(() => resolve())
                .catch(e => reject(e));
        } else {
            executeAsync('react-native', p)
                .then(() => resolve())
                .catch(e => reject(e));
        }
    } else {
        reject('Missing options for react-native command!');
    }
});

const archiveXcodeProject = (c, platform) => new Promise((resolve, reject) => {
    logTask(`archiveXcodeProject:${platform}`);

    const appFolderName = _getAppFolderName(c, platform);
    const sdk = platform === IOS ? 'iphoneos' : 'tvos';

    const appPath = getAppFolder(c, platform);
    const exportPath = path.join(appPath, 'release');

    const scheme = getConfigProp(c, platform, 'scheme');
    const bundleIsDev = getConfigProp(c, platform, 'bundleIsDev') === true;
    const p = [
        '-workspace',
        `${appPath}/${appFolderName}.xcworkspace`,
        '-scheme',
        scheme,
        '-sdk',
        sdk,
        '-configuration',
        'Release',
        'archive',
        '-archivePath',
        `${exportPath}/${scheme}.xcarchive`,
        '-allowProvisioningUpdates',
    ];

    logDebug('running', p);

    if (c.files.appConfigFile.platforms[platform].runScheme === 'Release') {
        packageBundleForXcode(c, platform, bundleIsDev)
            .then(() => executeAsync('xcodebuild', p))
            .then(() => resolve())
            .catch(e => reject(e));
    } else {
        executeAsync('xcodebuild', p)
            .then(() => resolve())
            .catch(e => reject(e));
    }
});

const exportXcodeProject = (c, platform) => new Promise((resolve, reject) => {
    logTask(`exportXcodeProject:${platform}`);

    const appPath = getAppFolder(c, platform);
    const exportPath = path.join(appPath, 'release');

    const scheme = getConfigProp(c, platform, 'scheme');
    const p = [
        '-exportArchive',
        '-archivePath',
        `${exportPath}/${scheme}.xcarchive`,
        '-exportOptionsPlist',
        `${appPath}/exportOptions.plist`,
        '-exportPath',
        `${exportPath}`,
        '-allowProvisioningUpdates',
    ];
    logDebug('running', p);

    executeAsync('xcodebuild', p)
        .then(() => {
            logSuccess(`Your IPA is located in ${chalk.white(exportPath)}.`);
            resolve();
        })
        .catch(e => reject(e));
});

const packageBundleForXcode = (c, platform, isDev = false) => {
    logTask(`packageBundleForXcode:${platform}`);
    const appFolderName = _getAppFolderName(c, platform);

    return executeAsync('react-native', [
        'bundle',
        '--platform',
        'ios',
        '--dev',
        isDev,
        '--assets-dest',
        `platformBuilds/${c.appId}_${platform}`,
        '--entry-file',
        `${c.files.appConfigFile.platforms[platform].entryFile}.js`,
        '--bundle-output',
        `${getAppFolder(c, platform)}/main.jsbundle`,
    ]);
};

const prepareXcodeProject = (c, platform) => new Promise((resolve, reject) => {
    const { device } = c.program;
    const ip = device ? getIP() : 'localhost';
    const appFolder = getAppFolder(c, platform);
    const appFolderName = _getAppFolderName(c, platform);
    const bundleAssets = getConfigProp(c, platform, 'bundleAssets') === true;

    // CHECK TEAM ID IF DEVICE
    const tId = getConfigProp(c, platform, 'teamID');
    if (device && (!tId || tId === '')) {
        logError(
            `Looks like you're missing teamID in your ${chalk.white(
                c.paths.appConfigPath,
            )} => .platforms.${platform}.teamID . you will not be able to build ${platform} app for device!`,
        );
        resolve();
        return;
    }

    const check = path.join(appFolder, `${appFolderName}.xcodeproj`);
    if (!fs.existsSync(check)) {
        logWarning(`Looks like your ${chalk.white(platform)} platformBuild is misconfigured!. let's repair it.`);
        createPlatformBuild(c, platform)
            .then(() => configureXcodeProject(c, platform))
            .then(() => _postConfigureProject(c, platform, appFolder, appFolderName, bundleAssets, ip))
            .then(() => resolve(c))
            .catch(e => reject(e));
        return;
    }
    if (!fs.existsSync(path.join(appFolder, 'Pods'))) {
        logWarning(`Looks like your ${platform} project is not configured yet. Let's configure it!`);
        configureXcodeProject(c, platform)
            .then(() => _postConfigureProject(c, platform, appFolder, appFolderName, bundleAssets, ip))
            .then(() => resolve(c))
            .catch(e => reject(e));
    } else {
        _postConfigureProject(c, platform, appFolder, appFolderName, bundleAssets, ip)
            .then(() => resolve(c))
            .catch(e => reject(e));
    }
});

const configureXcodeProject = (c, platform, ip, port) => new Promise((resolve, reject) => {
    logTask('configureXcodeProject');
    if (process.platform !== 'darwin') return;
    if (!isPlatformActive(c, platform, resolve)) return;

    const appFolderName = _getAppFolderName(c, platform);

    // configureIfRequired(c, platform)
    //     .then(() => copyAppleAssets(c, platform, appFolderName))
    copyAppleAssets(c, platform, appFolderName)
        .then(() => copyAppleAssets(c, platform, appFolderName))
        .then(() => copyBuildsFolder(c, platform))
        .then(() => _preConfigureProject(c, platform, appFolderName, ip, port))
        .then(() => runPod(c.program.update ? 'update' : 'install', getAppFolder(c, platform), true))
        .then(() => resolve())
        .catch((e) => {
            if (!c.program.update) {
                logWarning(`Looks like pod install is not enough! Let's try pod update! Error: ${e}`);
                runPod('update', getAppFolder(c, platform))
                    .then(() => _preConfigureProject(c, platform, appFolderName, ip, port))
                    .then(() => resolve())
                    .catch(err => reject(err));
            } else {
                reject(e);
            }
        });
});

const _injectPlugin = (c, plugin, key, pkg, pluginConfig) => {
    if (plugin.appDelegateImports instanceof Array) {
        plugin.appDelegateImports.forEach((appDelegateImport) => {
            // Avoid duplicate imports
            logTask('appDelegateImports add');
            if (pluginConfig.pluginAppDelegateImports.indexOf(appDelegateImport) === -1) {
                logTask('appDelegateImports add ok');
                pluginConfig.pluginAppDelegateImports += `import ${appDelegateImport}\n`;
            }
        });
    }
    if (plugin.appDelegateMethods instanceof Array) {
        pluginConfig.pluginAppDelegateMethods += `${plugin.appDelegateMethods.join('\n    ')}`;
    }
};

const _postConfigureProject = (c, platform, appFolder, appFolderName, isBundled = false, ip = 'localhost', port = 8081) => new Promise((resolve) => {
    logTask(`_postConfigureProject:${platform}:${ip}:${port}`);
    const appDelegate = 'AppDelegate.swift';

    const entryFile = getEntryFile(c, platform);
    const appTemplateFolder = getAppTemplateFolder(c, platform);
    const { backgroundColor } = c.files.appConfigFile.platforms[platform];
    const tId = getConfigProp(c, platform, 'teamID');
    let bundle;
    if (isBundled) {
        bundle = `RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "${entryFile}", fallbackResource: nil)`;
    } else {
        bundle = `URL(string: "http://${ip}:${port}/${entryFile}.bundle?platform=ios")`;
    }
    // INJECTORS
    const pluginAppDelegateImports = '';
    const pluginAppDelegateMethods = '';
    const pluginConfig = {
        pluginAppDelegateImports,
        pluginAppDelegateMethods,
    };

    // PLUGINS
    if (c.files.appConfigFile && c.files.pluginConfig) {
        const { includedPlugins } = c.files.appConfigFile.common;
        if (includedPlugins) {
            const { plugins } = c.files.pluginConfig;
            Object.keys(plugins).forEach((key) => {
                if (includedPlugins.includes('*') || includedPlugins.includes(key)) {
                    const plugin = getMergedPlugin(c, key, plugins)[platform];
                    if (plugin) {
                        if (plugins[key]['no-active'] !== true) {
                            _injectPlugin(c, plugin, key, plugin.package, pluginConfig);
                        }
                    }
                }
            });
        }
    }

    // BG COLOR
    let pluginBgColor = 'vc.view.backgroundColor = UIColor.white';
    const UI_COLORS = ['black', 'blue', 'brown', 'clear', 'cyan', 'darkGray', 'gray', 'green', 'lightGray', 'magneta', 'orange', 'purple', 'red', 'white', 'yellow'];
    if (backgroundColor) {
        if (UI_COLORS.includes(backgroundColor)) {
            pluginBgColor = `vc.view.backgroundColor = UIColor.${backgroundColor}`;
        } else {
            logWarning(`Your choosen color in config.json for platform ${chalk.white(platform)} is not supported by UIColor. use one of the predefined ones: ${chalk.white(UI_COLORS.join(','))}`);
        }
    }

    writeCleanFile(
        path.join(getAppTemplateFolder(c, platform), appFolderName, appDelegate),
        path.join(appFolder, appFolderName, appDelegate),
        [
            { pattern: '{{BUNDLE}}', override: bundle },
            { pattern: '{{ENTRY_FILE}}', override: entryFile },
            { pattern: '{{IP}}', override: ip },
            { pattern: '{{PORT}}', override: port },
            { pattern: '{{BACKGROUND_COLOR}}', override: pluginBgColor },
            {
                pattern: '{{APPDELEGATE_IMPORTS}}',
                override: pluginConfig.pluginAppDelegateImports,
            },
            {
                pattern: '{{APPDELEGATE_METHODS}}',
                override: pluginConfig.pluginAppDelegateMethods,
            },
        ],
    );

    writeCleanFile(path.join(appTemplateFolder, 'exportOptions.plist'), path.join(appFolder, 'exportOptions.plist'), [
        { pattern: '{{TEAM_ID}}', override: tId },
    ]);

    const projectPath = path.join(appFolder, `${appFolderName}.xcodeproj/project.pbxproj`);
    const xcodeProj = xcode.project(projectPath);
    xcodeProj.parse(() => {
        const appId = getAppId(c, platform);
        if (tId) {
            xcodeProj.updateBuildProperty('DEVELOPMENT_TEAM', tId);
        } else {
            xcodeProj.updateBuildProperty('DEVELOPMENT_TEAM', '""');
        }

        xcodeProj.updateBuildProperty('PRODUCT_BUNDLE_IDENTIFIER', appId);

        resolve();
    });
});

const _preConfigureProject = (c, platform, appFolderName, ip = 'localhost', port = 8081) => new Promise((resolve, reject) => {
    logTask(`_preConfigureProject:${platform}:${appFolderName}:${ip}:${port}`);

    const appFolder = getAppFolder(c, platform);
    const appTemplateFolder = getAppTemplateFolder(c, platform);
    const tId = getConfigProp(c, platform, 'teamID');
    const { permissions, orientationSupport, urlScheme, plistExtra } = c.files.appConfigFile.platforms[platform];

    fs.writeFileSync(path.join(appFolder, 'main.jsbundle'), '{}');
    mkdirSync(path.join(appFolder, 'assets'));
    mkdirSync(path.join(appFolder, `${appFolderName}/images`));

    const plistPath = path.join(appFolder, `${appFolderName}/Info.plist`);

    let pluginInject = '';
    // PLUGINS
    if (c.files.appConfigFile && c.files.pluginConfig) {
        const { includedPlugins } = c.files.appConfigFile.common;
        if (includedPlugins) {
            const { plugins } = c.files.pluginConfig;
            Object.keys(plugins).forEach((key) => {
                if (includedPlugins.includes('*') || includedPlugins.includes(key)) {
                    const plugin = getMergedPlugin(c, key, plugins)[platform];
                    if (plugin) {
                        if (plugins[key]['no-active'] !== true) {
                            const isNpm = plugins[key]['no-npm'] !== true;
                            if (isNpm) {
                                const podPath = plugin.path ? `../../${plugin.path}` : `../../node_modules/${key}`;
                                pluginInject += `  pod '${plugin.podName}', :path => '${podPath}'\n`;
                            } else if (plugin.git) {
                                const commit = plugin.commit ? `, :commit => '${plugin.commit}'` : '';
                                pluginInject += `  pod '${plugin.podName}', :git => '${plugin.git}'${commit}\n`;
                            } else if (plugin.version) {
                                pluginInject += `  pod '${plugin.podName}', '${plugin.version}'\n`;
                            }
                        }
                    }
                }
            });
        }
    }

    // PERMISSIONS
    let pluginPermissions = '';
    if (permissions) {
        permissions.forEach((v) => {
            if (c.files.permissionsConfig) {
                const plat = c.files.permissionsConfig.permissions[platform] ? platform : 'ios';
                const pc = c.files.permissionsConfig.permissions[plat];
                if (pc[v]) {
                    pluginPermissions += `  <key>${pc[v].key}</key>\n  <string>${pc[v].desc}</string>\n`;
                }
            }
        });
    }
    pluginPermissions = pluginPermissions.substring(0, pluginPermissions.length - 1);

    writeCleanFile(path.join(getAppTemplateFolder(c, platform), 'Podfile'), path.join(appFolder, 'Podfile'), [
        { pattern: '{{PLUGIN_PATHS}}', override: pluginInject },
    ]);

    // ORIENTATIONS
    let pluginOrientations = '';
    const pluginOrientationPhoneKey = '<key>UISupportedInterfaceOrientations</key>';
    const pluginOrientationTabKey = '<key>UISupportedInterfaceOrientations~ipad</key>';
    let pluginOrientationPhone = `${pluginOrientationPhoneKey}
    <array>
      <string>UIInterfaceOrientationPortrait</string>
    </array>`;
    let pluginOrientationTab = `${pluginOrientationTabKey}
    <array>
      <string>UIInterfaceOrientationPortrait</string>
    </array>`;

    if (orientationSupport) {
        if (orientationSupport.phone) {
            pluginOrientationPhone = `${pluginOrientationPhoneKey}\n    <array>\n`;
            orientationSupport.phone.forEach((v) => {
                pluginOrientationPhone += `<string>${v}</string>\n`;
            });
            pluginOrientationPhone += '    </array>';
        }
        if (orientationSupport.tab) {
            pluginOrientationTab = `${pluginOrientationTabKey}\n    <array>\n`;
            orientationSupport.tab.forEach((v) => {
                pluginOrientationTab += `<string>${v}</string>\n`;
            });
            pluginOrientationTab += '    </array>';
        }
    }
    pluginOrientations = `${pluginOrientationPhone}\n${pluginOrientationTab}`;

    // URL_SCHEMES
    let pluginUrlSchemes = '';

    if (urlScheme) {
        pluginUrlSchemes = `<key>CFBundleTypeRole</key>
      <string>Editor</string>
      <key>CFBundleURLName</key>
      <string>${urlScheme}</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>${urlScheme}</string>
      </array>`;
    }

    // PLIST EXTRAS
    let pluginPlistExtra = '';

    if (plistExtra) {
        for (const key in plistExtra) {
            let value;
            if (typeof plistExtra[key] === 'boolean') {
                value = `<${plistExtra[key]} />`;
            } else {
                value = `<string>${plistExtra[key]}</string>`;
            }
            pluginPlistExtra += `<key>${key}</key>\n${value}\n`;
        }
    }

    // PROJECT
    const projectPath = path.join(appFolder, `${appFolderName}.xcodeproj/project.pbxproj`);
    const xcodeProj = xcode.project(projectPath);
    xcodeProj.parse(() => {
        const appId = getAppId(c, platform);
        if (tId) {
            xcodeProj.updateBuildProperty('DEVELOPMENT_TEAM', tId);
        } else {
            xcodeProj.updateBuildProperty('DEVELOPMENT_TEAM', '""');
        }

        xcodeProj.updateBuildProperty('PRODUCT_BUNDLE_IDENTIFIER', appId);

        let pluginFonts = '';
        if (c.files.appConfigFile) {
            if (fs.existsSync(c.paths.fontsConfigFolder)) {
                fs.readdirSync(c.paths.fontsConfigFolder).forEach((font) => {
                    if (font.includes('.ttf') || font.includes('.otf')) {
                        const key = font.split('.')[0];
                        const { includedFonts } = c.files.appConfigFile.common;
                        if (includedFonts && (includedFonts.includes('*') || includedFonts.includes(key))) {
                            const fontSource = path.join(c.paths.projectConfigFolder, 'fonts', font);
                            if (fs.existsSync(fontSource)) {
                                const fontFolder = path.join(appFolder, 'fonts');
                                mkdirSync(fontFolder);
                                const fontDest = path.join(fontFolder, font);
                                copyFileSync(fontSource, fontDest);
                                xcodeProj.addResourceFile(fontSource);
                                pluginFonts += `  <string>${font}</string>\n`;
                            } else {
                                logWarning(`Font ${chalk.white(fontSource)} doesn't exist! Skipping.`);
                            }
                        }
                    }
                });
            }
        }

        fs.writeFileSync(projectPath, xcodeProj.writeSync());

        writeCleanFile(path.join(appTemplateFolder, `${appFolderName}/Info.plist`), plistPath, [
            { pattern: '{{PLUGIN_FONTS}}', override: pluginFonts },
            { pattern: '{{PLUGIN_PERMISSIONS}}', override: pluginPermissions },
            { pattern: '{{PLUGIN_APPTITLE}}', override: getAppTitle(c, platform) },
            { pattern: '{{PLUGIN_VERSION_STRING}}', override: getAppVersion(c, platform) },
            { pattern: '{{PLUGIN_ORIENTATIONS}}', override: pluginOrientations },
            { pattern: '{{PLUGIN_URL_SCHEMES}}', override: pluginUrlSchemes },
            { pattern: '{{PLUGIN_PLIST_EXTRA}}', override: pluginPlistExtra },
        ]);

        resolve();
    });
});

const _getAppFolderName = (c, platform) => {
    const projectFolder = getConfigProp(c, platform, 'projectFolder');
    if (projectFolder) {
        return projectFolder;
    }
    return platform === IOS ? 'RNVApp' : 'RNVAppTVOS';
};

const listAppleDevices = (c, platform) => new Promise((resolve) => {
    logTask(`listAppleDevices:${platform}`);

    const devicesArr = _getAppleDevices(c, platform);
    let devicesString = '\n';
    devicesArr.forEach((v, i) => {
        devicesString += `-[${i + 1}] ${chalk.white(v.name)} | ${v.icon} | v: ${chalk.green(v.version)} | udid: ${chalk.blue(v.udid)}${
            v.isDevice ? chalk.red(' (device)') : ''
        }\n`;
    });
    console.log(devicesString);
});

const launchAppleSimulator = (c, platform, target) => new Promise((resolve) => {
    logTask(`launchAppleSimulator:${platform}:${target}`);

    const devicesArr = _getAppleDevices(c, platform, true);
    let selectedDevice;
    for (let i = 0; i < devicesArr.length; i++) {
        if (devicesArr[i].name === target) {
            selectedDevice = devicesArr[i];
        }
    }
    if (selectedDevice) {
        _launchSimulator(selectedDevice);
        resolve(selectedDevice.name);
    } else {
        logWarning(`Your specified simulator target ${chalk.white(target)} doesn't exists`);
        const readlineInterface = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        let devicesString = '\n';
        devicesArr.forEach((v, i) => {
            devicesString += `-[${i + 1}] ${chalk.white(v.name)} | ${v.icon} | v: ${chalk.green(v.version)} | udid: ${chalk.blue(
                v.udid,
            )}${v.isDevice ? chalk.red(' (device)') : ''}\n`;
        });
        readlineInterface.question(getQuestion(`${devicesString}\nType number of the simulator you want to launch`), (v) => {
            const chosenDevice = devicesArr[parseInt(v, 10) - 1];
            if (chosenDevice) {
                _launchSimulator(chosenDevice);
                resolve(chosenDevice.name);
            } else {
                logError(`Wrong choice ${v}! Ingoring`);
            }
        });
    }
});

const _launchSimulator = (selectedDevice) => {
    try {
        child_process.spawnSync('xcrun', ['instruments', '-w', selectedDevice.udid]);
    } catch (e) {
        // instruments always fail with 255 because it expects more arguments,
        // but we want it to only launch the simulator
    }
};

const _getAppleDevices = (c, platform, ignoreDevices, ignoreSimulators) => {
    logTask(`_getAppleDevices:${platform},ignoreDevices:${ignoreDevices},ignoreSimulators${ignoreSimulators}`);
    const devices = child_process.execFileSync('xcrun', ['instruments', '-s'], {
        encoding: 'utf8',
    });

    const devicesArr = _parseIOSDevicesList(devices, platform, ignoreDevices, ignoreSimulators);
    return devicesArr;
};

const _parseIOSDevicesList = (text, platform, ignoreDevices = false, ignoreSimulators = false) => {
    const devices = [];
    text.split('\n').forEach((line) => {
        const s1 = line.match(/\[.*?\]/);
        const s2 = line.match(/\(.*?\)/g);
        const s3 = line.substring(0, line.indexOf('(') - 1);
        const s4 = line.substring(0, line.indexOf('[') - 1);
        let isSim = false;
        if (s2 && s1) {
            if (s2[s2.length - 1] === '(Simulator)') {
                isSim = true;
                s2.pop();
            }
            const version = s2.pop();
            const name = `${s4.substring(0, s4.lastIndexOf('(') - 1)}`;
            const udid = s1[0].replace(/\[|\]/g, '');
            const isDevice = !isSim;

            if ((isDevice && !ignoreDevices) || (!isDevice && !ignoreSimulators)) {
                switch (platform) {
                case IOS:
                    if (name.includes('iPhone') || name.includes('iPad') || name.includes('iPod') || isDevice) {
                        let icon = 'Phone 📱';
                        if (name.includes('iPad')) icon = 'Tablet 💊';
                        devices.push({ udid, name, version, isDevice, icon });
                    }
                    break;
                case TVOS:
                    if (name.includes('Apple TV') || isDevice) {
                        devices.push({ udid, name, version, isDevice, icon: 'TV 📺' });
                    }
                    break;
                default:
                    devices.push({ udid, name, version, isDevice });
                    break;
                }
            }
        }
    });

    return devices;
};

// Resolve or reject will not be called so this will keep running
const runAppleLog = c => new Promise(() => {
    const filter = c.program.filter || 'RNV';
    const child = child_process.execFile(
        'xcrun',
        ['simctl', 'spawn', 'booted', 'log', 'stream', '--predicate', `eventMessage contains \"${filter}\"`],
        { stdio: 'inherit', customFds: [0, 1, 2] },
    );
        // use event hooks to provide a callback to execute when data are available:
    child.stdout.on('data', (data) => {
        const d = data.toString();
        if (d.toLowerCase().includes('error')) {
            console.log(chalk.red(d));
        } else if (d.toLowerCase().includes('success')) {
            console.log(chalk.green(d));
        } else {
            console.log(d);
        }
    });
});

export {
    runPod,
    copyAppleAssets,
    configureXcodeProject,
    runXcodeProject,
    exportXcodeProject,
    archiveXcodeProject,
    packageBundleForXcode,
    listAppleDevices,
    launchAppleSimulator,
    runAppleLog,
    prepareXcodeProject,
};
