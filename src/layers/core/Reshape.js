import Layer from '../../Layer'
import Tensor from '../../Tensor'
import { webgl2 } from '../../WebGL2'
import _ from 'lodash'
import ops from 'ndarray-ops'

/**
 * Reshape layer class
 * Note there is no concept of batch size in these layers (single-batch).
 */
export default class Reshape extends Layer {
  /**
   * Creates a Reshape layer
   *
   * @param {Object} [attrs] - layer config attributes
   * @param {number[]} [attrs.target_shape]
   */
  constructor(attrs = {}) {
    super(attrs)
    this.layerClass = 'Reshape'

    const { target_shape = [] } = attrs
    this.targetShape = target_shape

    // GPU setup
    if (this.gpu) {
      this.mapInputProgram = webgl2.compileProgram(require('../../mapInput.glsl'))
    }
  }

  /**
   * Layer computational logic
   *
   * @param {Tensor} x
   * @returns {Tensor}
   */
  call(x) {
    if (this.gpu) {
      this._callGPU(x)
    } else {
      this._callCPU(x)
    }
    return this.output
  }

  /**
   * CPU call
   *
   * @param {Tensor} x
   */
  _callCPU(x) {
    if (this.targetShape.reduce((a, b) => a * b, 1) !== x.tensor.size) {
      this.throwError('The total size of new array must be unchanged in reshape layer.')
    }
    this.output = new Tensor([], this.targetShape)
    this.output.replaceTensorData(x.tensor.data)
  }

  /**
   * Creates row/col index mappings to map input texture to output texture
   */
  _createIndexMap() {
    if (this.rowIndexMap && this.colIndexMap) {
      return
    }

    const indicesRow = new Tensor([], this.inputShape, { type: Int32Array })
    const indicesCol = new Tensor([], this.inputShape, { type: Int32Array })

    if (this.inputShape.length === 2) {
      for (let i = 0; i < this.inputShape[0]; i++) {
        ops.assigns(indicesRow.tensor.pick(i, null), i)
      }
    } else if (this.inputShape.length === 3) {
      for (let i = 0; i < this.inputShape[0]; i++) {
        for (let j = 0; j < this.inputShape[1]; j++) {
          ops.assigns(indicesRow.tensor.pick(i, j, null), i * this.inputShape[1] + j)
        }
      }
    } else if (this.inputShape.length === 4) {
      for (let i = 0; i < this.inputShape[0]; i++) {
        for (let j = 0; j < this.inputShape[1]; j++) {
          for (let k = 0; k < this.inputShape[2]; k++) {
            ops.assigns(
              indicesRow.tensor.pick(i, j, k, null),
              i * this.inputShape[1] * this.inputShape[2] + j * this.inputShape[2] + k
            )
          }
        }
      }
    }
    for (let c = 0; c < _.last(this.inputShape); c++) {
      ops.assigns(indicesCol.tensor.pick(...Array(this.inputShape.length - 1).fill(null), c), c)
    }

    this.rowIndexMap = new Tensor([], this.targetShape, { type: Int32Array })
    this.colIndexMap = new Tensor([], this.targetShape, { type: Int32Array })
    this.rowIndexMap.replaceTensorData(new Int32Array(indicesRow.tensor.data))
    this.colIndexMap.replaceTensorData(new Int32Array(indicesCol.tensor.data))
    if (this.targetShape.length > 2) {
      this.rowIndexMap.reshapeTo2D()
      this.colIndexMap.reshapeTo2D()
    }

    this.rowIndexMap.createGLTexture('2d', 'int')
    this.colIndexMap.createGLTexture('2d', 'int')
  }

  /**
   * GPU call
   *
   * @param {Tensor} x
   */
  _callGPU(x) {
    if (!x.glTexture) {
      this.inputShape = x.tensor.shape
      if (x.tensor.shape.length <= 2) {
        x.createGLTexture()
      } else if (x.tensor.shape.length > 2 && !x.is2DReshaped) {
        x.reshapeTo2D()
        x.createGLTexture()
      }
    } else if (x.is2DReshaped) {
      this.inputShape = x.originalShape
    } else {
      this.inputShape = x.tensor.shape
    }
    this._createIndexMap()

    if (!this.output) {
      this.output = new Tensor([], this.targetShape)
      if (this.targetShape.length > 2) {
        this.output.reshapeTo2D()
      }
      this.output.createGLTexture()
    }

    webgl2.runProgram({
      program: this.mapInputProgram,
      output: this.output,
      inputs: [
        { texture: x.glTexture, type: '2d', name: 'x' },
        { texture: this.rowIndexMap.glTexture, type: '2d', name: 'rowIndexMap' },
        { texture: this.colIndexMap.glTexture, type: '2d', name: 'colIndexMap' }
      ]
    })

    // GPU -> CPU data transfer
    if (this.outbound.length === 0) {
      this.output.transferFromGLTexture()
      if (this.output.is2DReshaped) {
        this.output.reshapeFrom2D(this.axis)
      }
    }
  }
}
