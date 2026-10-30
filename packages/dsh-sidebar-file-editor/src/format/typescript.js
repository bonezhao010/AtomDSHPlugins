/** TypeScript and TSX parser plus the ESTree printer. */
import * as typescript from 'prettier/plugins/typescript'
import * as estree from 'prettier/plugins/estree'

export const plugins = [typescript, estree]
