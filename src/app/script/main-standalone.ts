/**
 * by bitbof (bitbof.com)
 */

import './polyfills/polyfills';
import { KlApp } from './app/kl-app';
import { TDeserializedKlStorageProject, TKlProject } from './klecks/kl-types';
import { initLANG, LANG } from './language/language';
import '../script/theme/theme';
import {
    getKlIndexedDbName,
    KL_INDEXED_DB,
    KL_INDEXED_DB_STORES,
    KL_INDEXED_DB_UPGRADER,
    KL_INDEXED_DB_VERSION,
} from './klecks/storage/kl-indexed-db';
import { KlRecoveryManager } from './klecks/storage/kl-recovery-manager';

// 初始化错误模块
function showInitError(e: Error): void {
    const el = document.createElement('div');
    el.style.textAlign = 'center';
    el.style.background = '#fff';
    el.style.padding = '20px';
    el.innerHTML = '<h1>App failed to initialize</h1>';
    const errorMsg = document.createElement('div');
    errorMsg.textContent = 'Error: ' + (e.message ? e.message : '' + e);
    el.append(errorMsg);
    document.body.append(el);
    console.error(e);
}

(async () => {
    try {
        const outQueue: string[] = [];
        await initLANG();

        // 初始化 IndexedDB
        KL_INDEXED_DB.init(
            getKlIndexedDbName(),
            KL_INDEXED_DB_STORES,
            KL_INDEXED_DB_VERSION,
            KL_INDEXED_DB_UPGRADER,
        );
        if (!(await KL_INDEXED_DB.testConnection())) {
            outQueue.push(LANG('file-storage-cant-access'));
        }

        // 创建恢复管理器
        const klRecoveryManager: KlRecoveryManager | undefined = KL_INDEXED_DB.getIsAvailable()
            ? new KlRecoveryManager({})
            : undefined;
        let project: TKlProject | undefined = undefined;
        try {
            // 尝试从恢复管理器中获取项目
            const readResult: TDeserializedKlStorageProject | undefined = klRecoveryManager
                ? await klRecoveryManager.getRecovery()
                : undefined;
            if (readResult) {
                project = readResult.project;
                outQueue.push(LANG('tab-recovery-recovered'));
            }
        } catch (e) {
            setTimeout(() => {
                throw e;
            });
            outQueue.push(LANG('tab-recovery-failed-to-recover'));
        }

         // 移除加载屏幕
        // in case an extension manipulated the page
        const loadingScreenEl = document.getElementById('loading-screen');
        loadingScreenEl?.remove();

        // 创建KlApp实例
        const klApp = new KlApp({ project, klRecoveryManager });
        document.body.append(klApp.getElement());

        // 显示输出队列中的消息
        setTimeout(() => {
            outQueue.forEach((msg) => {
                klApp.out(msg);
            });
        }, 100);
    } catch (e) {
        showInitError(e as Error);
    }
})();
