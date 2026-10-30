/** JavaScript, JSX, JSON, JSONC, and JSON5 parsers plus the ESTree printer. */
import * as babel from 'prettier/plugins/babel'
import * as estree from 'prettier/plugins/estree'

export const plugins = [babel, estree]
