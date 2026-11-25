const fs = require('node:fs')
const path = require('node:path')

function recycleStaleDist(widgetRoot) {
  const ts = require('typescript')
  const configFile = path.join(widgetRoot, 'tsconfig.json')
  const config = ts.readConfigFile(configFile, ts.sys.readFile)
  if (config.error) throw Error('Widget TypeScript configuration is unreadable')
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, widgetRoot)
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true })
  const sourceRoot = path.resolve(widgetRoot, parsed.options.rootDir || 'src')
  const outputRoot = path.resolve(widgetRoot, parsed.options.outDir || 'dist')
  if (!outputRoot.startsWith(path.resolve(widgetRoot) + path.sep)) throw Error('Widget output outside package')
  const expected = new Set()
  for (const file of program.getSourceFiles()) {
    const sourceFile = path.resolve(file.fileName)
    if (!file.isDeclarationFile && sourceFile.startsWith(sourceRoot + path.sep)) {
      const output = path.resolve(outputRoot, path.relative(sourceRoot, sourceFile).replace(/\.tsx?$/, '.js'))
      expected.add(output)
      if (parsed.options.sourceMap) expected.add(output + '.map')
    }
  }
  if (!fs.existsSync(outputRoot)) return 0
  if (!expected.size) throw Error('No widget emit targets; output recycling refused')
  if (fs.lstatSync(outputRoot).isSymbolicLink()) throw Error('Linked widget output root requires review')
  const { recycleOutput } = require(path.resolve(widgetRoot, '../../scripts/recycle-output.cjs'))
  let count = 0
  function walk(directory) {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name)
      const stat = fs.lstatSync(file)
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw Error('Linked widget output requires review')
      if (stat.isDirectory()) { if (name !== 'renderer' && name !== 'native') walk(file) }
      else if (/\.js(?:\.map)?$/.test(name) && !expected.has(file)) { recycleOutput(path.resolve(widgetRoot, '../..'), file); count++ }
    }
  }
  walk(outputRoot)
  return count
}
module.exports = { recycleStaleDist }
