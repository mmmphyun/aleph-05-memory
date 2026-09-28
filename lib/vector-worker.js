/**
 * Node.js 내장 worker_threads 기반 임베딩 비동기 격리 워커 모듈
 * 
 * @xenova/transformers INT8 ONNX 행렬 곱셈 및 토크나이징 연산을
 * V8 메인 스레드 이벤트 루프에서 격리된 백그라운드 워커 스레드로 오프로딩하여,
 * 대량 세션 인덱싱 시 발생하는 CPU Starvation(루프 동결)을 완전히 차단합니다.
 */

const { Worker, isMainThread, parentPort } = require('node:worker_threads');
const path = require('node:path');

// ============================================================================
// 1. Worker Thread Execution Context (워커 스레드 내부 로직)
// ============================================================================
if (!isMainThread) {
  const { embedText, batchEmbedPassages } = require('./vector-engine');

  parentPort.on('message', async (task) => {
    const { taskId, action, payload } = task;

    try {
      if (action === 'embed') {
        const { text, isQuery, options } = payload;
        const vector = await embedText(text, isQuery, options);
        // Float32Array를 그대로 전송 (복제 또는 전송)
        parentPort.postMessage({
          taskId,
          success: true,
          data: Array.from(vector)
        });
      } else if (action === 'batch') {
        const { texts, options } = payload;
        const vectors = await batchEmbedPassages(texts, options);
        parentPort.postMessage({
          taskId,
          success: true,
          data: vectors.map((v) => Array.from(v))
        });
      } else {
        parentPort.postMessage({
          taskId,
          success: false,
          error: `Unknown worker action: ${action}`
        });
      }
    } catch (err) {
      parentPort.postMessage({
        taskId,
        success: false,
        error: err.message || String(err)
      });
    }
  });

  // 워커 스레드에서는 아래 메인 클래스를 실행하지 않고 종료
  return;
}

// ============================================================================
// 2. Main Thread Client / Pool Controller (메인 스레드 컨트롤러)
// ============================================================================
class VectorWorkerClient {
  /**
   * @param {Object} [options]
   * @param {number} [options.timeoutMs=15000] - 단일 작업 타임아웃
   * @param {boolean} [options.disableWorker=false] - 테스트/디버깅용 인프로세스 폴백
   */
  constructor(options = {}) {
    this.timeoutMs = options.timeoutMs || 15000;
    this.disableWorker = Boolean(options.disableWorker);
    this.worker = null;
    this.pendingTasks = new Map();
    this.nextTaskId = 1;
    this.isTerminated = false;
  }

  /**
   * 백그라운드 Worker 스레드 초기화
   * @private
   */
  _ensureWorker() {
    if (this.disableWorker || this.isTerminated) return;
    if (this.worker) return;

    // 현재 파일 자체를 워커 엔트리로 실행
    this.worker = new Worker(__filename);

    this.worker.on('message', (response) => {
      const { taskId, success, data, error } = response;
      const deferred = this.pendingTasks.get(taskId);
      if (!deferred) return;

      this.pendingTasks.delete(taskId);
      clearTimeout(deferred.timer);

      if (success) {
        deferred.resolve(data);
      } else {
        deferred.reject(new Error(`[WorkerError] ${error}`));
      }
    });

    this.worker.on('error', (err) => {
      // 대기 중인 모든 태스크 에러 리젝트 및 워커 정리
      for (const [taskId, deferred] of this.pendingTasks.entries()) {
        clearTimeout(deferred.timer);
        deferred.reject(new Error(`[WorkerCrash] ${err.message}`));
      }
      this.pendingTasks.clear();
      this.worker = null;
    });

    this.worker.on('exit', (code) => {
      if (!this.isTerminated && code !== 0) {
        for (const [taskId, deferred] of this.pendingTasks.entries()) {
          clearTimeout(deferred.timer);
          deferred.reject(new Error(`[WorkerExit] Worker stopped with exit code ${code}`));
        }
        this.pendingTasks.clear();
      }
      this.worker = null;
    });
  }

  /**
   * 워커에 작업 디스패치 및 타임아웃 감시
   * @private
   */
  _dispatch(action, payload) {
    if (this.isTerminated) {
      return Promise.reject(new Error('VectorWorkerClient is terminated'));
    }

    // 워커 비활성화 시 메인 스레드 인프로세스 직접 실행 (Fallback)
    if (this.disableWorker) {
      const { embedText, batchEmbedPassages } = require('./vector-engine');
      if (action === 'embed') {
        return embedText(payload.text, payload.isQuery, payload.options)
          .then((vec) => Array.from(vec));
      } else if (action === 'batch') {
        return batchEmbedPassages(payload.texts, payload.options)
          .then((vecs) => vecs.map((v) => Array.from(v)));
      }
    }

    this._ensureWorker();

    const taskId = this.nextTaskId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTasks.delete(taskId);
        // 타임아웃 발생 시 응답 없는 워커 강제 종료 후 재생성
        if (this.worker) {
          this.worker.terminate().catch(() => {});
          this.worker = null;
        }
        reject(new Error(`[WorkerTimeout] Task ${taskId} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pendingTasks.set(taskId, { resolve, reject, timer });

      this.worker.postMessage({
        taskId,
        action,
        payload
      });
    });
  }

  /**
   * 단일 텍스트 임베딩 디스패치 (워커 비동기)
   * 
   * @param {string} text - 원본 텍스트
   * @param {boolean} [isQuery=false] - 검색 쿼리 여부
   * @param {Object} [options={}]
   * @returns {Promise<Float32Array>} 384차원 정규화 벡터
   */
  async embed(text, isQuery = false, options = {}) {
    const rawArray = await this._dispatch('embed', { text, isQuery, options });
    return new Float32Array(rawArray);
  }

  /**
   * 복수 텍스트 배치 임베딩 디스패치 (워커 비동기)
   * 
   * @param {Array<string>} texts - 임베딩할 텍스트 배열
   * @param {Object} [options={}]
   * @returns {Promise<Array<Float32Array>>} 384차원 정규화 벡터 배열
   */
  async batchEmbed(texts, options = {}) {
    const rawArrays = await this._dispatch('batch', { texts, options });
    return rawArrays.map((arr) => new Float32Array(arr));
  }

  /**
   * 워커 스레드 및 보류 작업 명시적 종료
   */
  async terminate() {
    this.isTerminated = true;
    for (const [taskId, deferred] of this.pendingTasks.entries()) {
      clearTimeout(deferred.timer);
      deferred.reject(new Error('VectorWorkerClient terminated'));
    }
    this.pendingTasks.clear();

    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
  }
}

// 싱글톤 기본 인스턴스
let defaultClient = null;

function getDefaultWorkerClient() {
  if (!defaultClient) {
    defaultClient = new VectorWorkerClient();
  }
  return defaultClient;
}

module.exports = {
  VectorWorkerClient,
  getDefaultWorkerClient
};
