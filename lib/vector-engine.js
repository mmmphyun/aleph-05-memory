/**
 * 로컬 다국어 임베딩 엔진 (Vector Engine)
 * 
 * @xenova/transformers 런타임을 통해 intfloat/multilingual-e5-small (INT8 양자화 ONNX)
 * 모델을 Node.js 프로세스 내장(In-Process)으로 실행합니다.
 * 외부 Python 데몬 없이 384차원 Dense Vector 임베딩 생성 및 코사인 유사도 연산을 수행합니다.
 */

const path = require('node:path');
const fs = require('node:fs');

const DEFAULT_MODEL_NAME = 'Xenova/multilingual-e5-small';
const DEFAULT_MODEL_CACHE_DIR = path.resolve(process.cwd(), '.session-memory', 'models');

let pipelineInstance = null;
let pipelinePromise = null;

/**
 * Transformers 환경 설정 및 파이프라인 싱글톤 인스턴스 초기화 (지연 로딩)
 * 
 * @param {Object} options - 엔진 옵션
 * @param {string} [options.cacheDir] - 모델 캐시 디렉토리
 * @param {string} [options.modelName] - 사용할 임베딩 모델 식별자
 * @returns {Promise<Function>} feature-extraction 파이프라인
 */
async function getPipeline(options = {}) {
  if (pipelineInstance) {
    return pipelineInstance;
  }

  if (pipelinePromise) {
    return pipelinePromise;
  }

  pipelinePromise = (async () => {
    const { pipeline, env } = await import('@xenova/transformers');

    const cacheDir = options.cacheDir || DEFAULT_MODEL_CACHE_DIR;
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    env.cacheDir = cacheDir;
    env.allowLocalModels = true;
    env.allowRemoteModels = true;

    const modelName = options.modelName || DEFAULT_MODEL_NAME;

    // INT8 양자화된 ONNX 모델 로드 (약 118MB)
    const extractor = await pipeline('feature-extraction', modelName, {
      quantized: true
    });

    pipelineInstance = extractor;
    return pipelineInstance;
  })();

  return pipelinePromise;
}

/**
 * 384차원 벡터에 대한 L2 정규화 (Euclidean Normalization)
 * L2 정규화를 거치면 코사인 유사도가 단순 내적(Dot Product)과 동일해져 O(D) 고속 연산 가능
 * 
 * @param {Float32Array|Array<number>} vector - 원본 임베딩 벡터
 * @returns {Float32Array} 정규화된 384차원 벡터
 */
function normalizeL2(vector) {
  let sumSq = 0;
  const len = vector.length;
  for (let i = 0; i < len; i++) {
    sumSq += vector[i] * vector[i];
  }

  const norm = Math.sqrt(sumSq);
  if (norm === 0) {
    return new Float32Array(len);
  }

  const normalized = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    normalized[i] = vector[i] / norm;
  }
  return normalized;
}

/**
 * 정규화된 두 벡터 간의 코사인 유사도(내적) 계산
 * 
 * @param {Float32Array|Array<number>} vecA - 벡터 A
 * @param {Float32Array|Array<number>} vecB - 벡터 B
 * @returns {number} 코사인 유사도 (-1.0 ~ 1.0)
 */
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) {
    return 0;
  }

  let dotProduct = 0;
  const len = vecA.length;
  for (let i = 0; i < len; i++) {
    dotProduct += vecA[i] * vecB[i];
  }

  return Number(dotProduct.toFixed(6));
}

/**
 * 단일 텍스트에 대한 E5 Dense Vector 임베딩 생성
 * 
 * E5 모델의 비대칭 인출(Asymmetric Retrieval) 규격 준수:
 * - 검색 쿼리: 'query: ${text}'
 * - 인덱싱 문서(청크): 'passage: ${text}'
 * 
 * @param {string} text - 원본 텍스트
 * @param {boolean} [isQuery=false] - 쿼리 여부 (true면 'query: ', false면 'passage: ')
 * @param {Object} [options={}] - 파이프라인 옵션
 * @returns {Promise<Float32Array>} L2 정규화된 384차원 Float32Array 벡터
 */
async function embedText(text, isQuery = false, options = {}) {
  if (!text || typeof text !== 'string' || text.trim() === '') {
    return new Float32Array(384);
  }

  const prefix = isQuery ? 'query: ' : 'passage: ';
  const preparedText = `${prefix}${text.trim()}`;

  const extractor = await getPipeline(options);
  const output = await extractor(preparedText, {
    pooling: 'mean',
    normalize: true
  });

  // output.data는 Float32Array 반환
  const rawArray = output.data;
  return normalizeL2(rawArray);
}

/**
 * 청크 배열에 대한 배치 임베딩 연산
 * 
 * @param {Array<string>} texts - 임베딩할 텍스트 배열
 * @param {Object} [options={}] - 옵션 및 프로그레스 콜백
 * @param {Function} [options.onProgress] - (completed, total) => void
 * @returns {Promise<Array<Float32Array>>} 384차원 벡터 배열
 */
async function batchEmbedPassages(texts, options = {}) {
  const results = [];
  const total = texts.length;

  for (let i = 0; i < total; i++) {
    const vec = await embedText(texts[i], false, options);
    results.push(vec);
    if (typeof options.onProgress === 'function') {
      options.onProgress(i + 1, total);
    }
  }

  return results;
}

module.exports = {
  DEFAULT_MODEL_NAME,
  DEFAULT_MODEL_CACHE_DIR,
  getPipeline,
  normalizeL2,
  cosineSimilarity,
  embedText,
  batchEmbedPassages
};
