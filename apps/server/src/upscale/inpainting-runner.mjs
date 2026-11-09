import { readFile, writeFile } from 'node:fs/promises'
import * as ort from 'onnxruntime-node'

const [modelPath, imagePath, maskPath, outputPath] = process.argv.slice(2)
if (modelPath === '--check-runtime') {
  console.log('ONNX Runtime native bindings loaded')
  process.exit(0)
}
if (!modelPath || !imagePath || !maskPath || !outputPath) throw new Error('Missing inpainting runner arguments')
const imageBytes = await readFile(imagePath)
const maskBytes = await readFile(maskPath)
if (imageBytes.byteLength !== 3 * 512 * 512 * 4 || maskBytes.byteLength !== 512 * 512 * 4) throw new Error('Invalid inpainting tensor files')
const image = new Float32Array(imageBytes.buffer, imageBytes.byteOffset, imageBytes.byteLength / 4)
const mask = new Float32Array(maskBytes.buffer, maskBytes.byteOffset, maskBytes.byteLength / 4)
const session = await ort.InferenceSession.create(modelPath, {
  executionProviders: ['cpu'],
  executionMode: 'sequential',
  intraOpNumThreads: 2,
  interOpNumThreads: 1,
})
try {
  if (session.inputNames.join(',') !== 'image,mask' || session.outputNames[0] !== 'output') throw new Error('LaMa model interface mismatch')
  // Lifecycle marker for supervised cancellation regression; never log image/model contents.
  console.log('MEDIAGRAB_INPAINT_INFERENCE_STARTED')
  const result = await session.run({
    image: new ort.Tensor('float32', image, [1, 3, 512, 512]),
    mask: new ort.Tensor('float32', mask, [1, 1, 512, 512]),
  })
  const values = result.output?.data
  if (!(values instanceof Float32Array) || values.length !== 3 * 512 * 512) throw new Error('Invalid model output')
  await writeFile(outputPath, Buffer.from(values.buffer, values.byteOffset, values.byteLength))
} finally {
  await session.release()
}
