/* eslint-disable import/no-cycle */
// @todo fix cycle dep
import chalk from 'chalk';
import path from 'path';
import fs from 'fs';
import {
    isPlatformSupportedSync,
    getConfig,
    logTask,
    getQuestion,
    logSuccess,
    askQuestion,
    finishQuestion
} from '../common';
import { cleanFolder, copyFolderContentsRecursiveSync } from '../systemTools/fileutils';
import { executePipe } from '../projectTools/buildHooks';

const CONFIGURE = 'configure';
const UPDATE = 'update';
const LIST = 'list';
const ADD = 'add';
const REMOVE = 'remove';
const EJECT = 'eject';
const CONNECT = 'connect';

const PIPES = {
    PLATFORM_CONFIGURE_BEFORE: 'platform:configure:before',
    PLATFORM_CONFIGURE_AFTER: 'platform:configure:after',
    PLATFORM_UPDATE_BEFORE: 'platform:update:before',
    PLATFORM_UPDATE_AFTER: 'platform:update:after',
    PLATFORM_LIST_BEFORE: 'platform:list:before',
    PLATFORM_LIST_AFTER: 'platform:list:after',
    PLATFORM_ADD_BEFORE: 'platform:add:before',
    PLATFORM_ADD_AFTER: 'platform:add:after',
    PLATFORM_REMOVE_BEFORE: 'platform:remove:before',
    PLATFORM_REMOVE_AFTER: 'platform:remove:after',
    PLATFORM_EJECT_BEFORE: 'platform:eject:before',
    PLATFORM_EJECT_AFTER: 'platform:ejecct:after',
    PLATFORM_CONNECT_BEFORE: 'platform:connect:before',
    PLATFORM_CONNECT_AFTER: 'platform:connect:after',
};

// ##########################################
// PUBLIC API
// ##########################################

const run = (c) => {
    logTask('run');

    switch (c.subCommand) {
    case CONFIGURE:
        return _runCreatePlatforms(c);
    case EJECT:
        return _runEjectPlatforms(c);
    case CONNECT:
        return _runConnectPlatforms(c);
        // case UPDATE:
        //     return Promise.resolve();
        //     break;
        // case LIST:
        //     return Promise.resolve();
        //     break;
        // case ADD:
        //     return Promise.resolve();
        //     break;
        // case REMOVE:
        //     return Promise.resolve();
        //     break;
    default:
        return Promise.reject(`Sub-Command ${c.subCommand} not supported`);
    }
};

// ##########################################
// PRIVATE
// ##########################################

const _runCreatePlatforms = c => new Promise((resolve, reject) => {
    const p = c.program.platform || 'all';
    logTask(`_runCreatePlatforms:${p}`);

    executePipe(c, PIPES.PLATFORM_CONFIGURE_BEFORE)
        .then(() => cleanPlatformBuild(c, p))
        .then(() => _runCleanPlaformAssets(c))
        .then(() => _runCopyPlatforms(c, p))
        .then(() => executePipe(c, PIPES.PLATFORM_CONFIGURE_AFTER))
        .then(() => resolve())
        .catch(e => reject(e));
});

const _runEjectPlatforms = c => new Promise((resolve) => {
    logTask('_runEjectPlatforms');

    askQuestion('This will copy platformTemplates folder from ReNative managed directly to your project. Type (y) to confirm')
        .then((v) => {
            finishQuestion();
            if (v.toLowerCase() === 'y') {
                const ptfn = 'platformTemplates';

                const supportedPlatforms = c.files.projectPackage ? c.files.projectPackage.supportedPlatforms : null;
                const rptf = c.paths.rnvPlatformTemplatesFolder;
                const prf = c.paths.projectRootFolder;
                if (supportedPlatforms) {
                    copyFolderContentsRecursiveSync(path.join(rptf, '_shared'), path.join(prf, ptfn, '_shared'));
                    for (let i = 0; i < supportedPlatforms.length; i++) {
                        const sp = supportedPlatforms[i];
                        copyFolderContentsRecursiveSync(path.join(rptf, sp), path.join(prf, ptfn, sp));
                    }
                } else {
                    copyFolderContentsRecursiveSync(rptf, path.join(prf, ptfn));
                }


                c.files.projectConfig.platformTemplatesFolder = `./${ptfn}`;

                fs.writeFileSync(c.paths.projectConfigPath, JSON.stringify(c.files.projectConfig, null, 2));

                logSuccess(
                    `Your platform templates are located in ${chalk.white(
                        c.files.projectConfig.platformTemplatesFolder
                    )} now. You can edit them directly!`
                );

                resolve();
            } else {
                resolve();
            }
        });
});

const _runConnectPlatforms = c => new Promise((resolve) => {
    logTask('_runConnectPlatforms');

    askQuestion('This will point platformTemplates folder from your local project to ReNative managed one. Type (y) to confirm')
        .then((v) => {
            finishQuestion();
            if (v.toLowerCase() === 'y') {
                const ptfn = 'platformTemplates';

                c.files.projectConfig.platformTemplatesFolder = `RNV_HOME/${ptfn}`;

                fs.writeFileSync(c.paths.projectConfigPath, JSON.stringify(c.files.projectConfig, null, 2));

                logSuccess(
                    `You're now using ReNativeplatformTemplates located in ${chalk.white(c.paths.rnvPlatformTemplatesFolder)} now!`
                );

                resolve();
            } else {
                resolve();
            }
        });
});

const _addPlatform = (platform, program, process) => new Promise((resolve, reject) => {
    if (!isPlatformSupportedSync(platform, resolve)) return;

    getConfig().then((v) => {
        _runAddPlatform()
            .then(() => resolve())
            .catch(e => reject(e));
    });
});

const _removePlatform = (platform, program, process) => new Promise((resolve, reject) => {
    if (!isPlatformSupportedSync(platform, resolve)) return;
    console.log('REMOVE_PLATFORM: ', platform);
    resolve();
});

const _runCleanPlaformAssets = c => new Promise((resolve, reject) => {
    logTask('_runCleanPlaformAssets');

    cleanFolder(c.paths.platformAssetsFolder).then(() => {
        resolve();
    });
});

const _runCopyPlatforms = (c, platform) => new Promise((resolve, reject) => {
    logTask(`_runCopyPlatforms:${platform}`);
    const copyPlatformTasks = [];
    if (platform === 'all') {
        for (const k in c.files.appConfigFile.platforms) {
            if (isPlatformSupportedSync(k)) {
                const ptPath = path.join(c.paths.platformTemplatesFolder, `${k}`);
                const pPath = path.join(c.paths.platformBuildsFolder, `${c.appId}_${k}`);
                copyPlatformTasks.push(copyFolderContentsRecursiveSync(ptPath, pPath));
            }
        }
    } else if (isPlatformSupportedSync(platform)) {
        const ptPath = path.join(c.paths.platformTemplatesFolder, `${platform}`);
        const pPath = path.join(c.paths.platformBuildsFolder, `${c.appId}_${platform}`);
        copyPlatformTasks.push(copyFolderContentsRecursiveSync(ptPath, pPath));
    } else {
        logWarning(`Your platform ${chalk.white(platform)} config is not present. Check ${chalk.white(c.paths.appConfigPath)}`);
    }

    Promise.all(copyPlatformTasks).then((values) => {
        resolve();
    });
});

const cleanPlatformBuild = (c, platform) => new Promise((resolve, reject) => {
    logTask(`cleanPlatformBuild:${platform}`);

    const cleanTasks = [];

    if (platform === 'all') {
        for (const k in c.files.appConfigFile.platforms) {
            if (isPlatformSupportedSync(k)) {
                const pPath = path.join(c.paths.platformBuildsFolder, `${c.appId}_${k}`);
                cleanTasks.push(cleanFolder(pPath));
            }
        }
    } else if (isPlatformSupportedSync(platform)) {
        const pPath = path.join(c.paths.platformBuildsFolder, `${c.appId}_${platform}`);
        cleanTasks.push(cleanFolder(pPath));
    }

    Promise.all(cleanTasks).then((values) => {
        resolve();
    });
});

const _runAddPlatform = c => new Promise((resolve, reject) => {
    logTask('runAddPlatform');
    resolve();
});

const createPlatformBuild = (c, platform) => new Promise((resolve, reject) => {
    logTask(`createPlatformBuild:${platform}`);

    if (!isPlatformSupportedSync(platform, null, reject)) return;

    const pPath = path.join(c.paths.platformBuildsFolder, `${c.appId}_${platform}`);
    const ptPath = path.join(c.paths.platformTemplatesFolder, `${platform}`);
    copyFolderContentsRecursiveSync(ptPath, pPath, false, [path.join(ptPath, '_privateConfig')]);

    resolve();
});

export { createPlatformBuild, cleanPlatformBuild, PIPES };

export default run;
