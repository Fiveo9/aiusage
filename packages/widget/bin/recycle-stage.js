const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const { randomUUID } = require('node:crypto')

function recycleStage(widgetRoot, stage) {
  const source = path.resolve(stage)
  const temporary = path.resolve(tmpdir())
  if (path.dirname(source) !== temporary || !path.basename(source).startsWith('aiusage-widget-native-')) throw Error('Unexpected native staging path')
  function inspect(file) {
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw Error('Linked native stage requires review')
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) inspect(path.join(file, name))
  }
  inspect(source)
  const owned = fs.realpathSync(widgetRoot)
  const bin = path.join(owned, 'backups', 'native-install')
  for (const candidate of [path.join(owned, 'backups'), bin]) {
    if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) throw Error('Linked native recycle path requires review')
  }
  fs.mkdirSync(bin, { recursive: true })
  const destination = path.join(bin, path.basename(source) + '-' + randomUUID())
  if (!destination.startsWith(owned + path.sep)) throw Error('Native recycle target outside package')
  fs.renameSync(source, destination)
  return destination
}
module.exports = { recycleStage }
