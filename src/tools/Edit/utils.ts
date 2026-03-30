import { readFileSync } from 'fs'
import { detectFileEncoding, detectLineEndings, normalizeFilePath } from '../../util/file'
import { type Hunk } from 'diff'
import { getPatch } from '../../util/diff'

/**
 * Applies an edit to a file and returns the patch and updated file.
 * Does not write the file to disk.
 */
export function applyEdit(
  file_path: string,
  old_string: string,
  new_string: string,
  replace_all: boolean = false,
): { patch: Hunk[]; updatedFile: string } {
  const fullFilePath = normalizeFilePath(file_path)

  let originalFile
  let updatedFile
  if (old_string === '') {
    // Create new file
    originalFile = ''
    updatedFile = new_string
  } else {
    // Edit existing file
    const enc = detectFileEncoding(fullFilePath)
    originalFile = readFileSync(fullFilePath, enc)
    const lineEndings = detectLineEndings(fullFilePath)
    const normalizedOldString = lineEndings === 'CRLF'
      ? old_string.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
      : old_string.replace(/\r\n/g, '\n')
    const normalizedNewString = lineEndings === 'CRLF'
      ? new_string.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
      : new_string.replace(/\r\n/g, '\n')
    const replaceFunc = replace_all
      ? (str: string, search: string, replacement: string) => str.replaceAll(search, replacement)
      : (str: string, search: string, replacement: string) => str.replace(search, replacement)

    if (new_string === '') {
      if (
        !normalizedOldString.endsWith('\n') &&
        !normalizedOldString.endsWith('\r\n') &&
        (originalFile.includes(normalizedOldString + '\r\n') || originalFile.includes(normalizedOldString + '\n'))
      ) {
        const suffix = lineEndings === 'CRLF' ? '\r\n' : '\n'
        updatedFile = replaceFunc(originalFile, normalizedOldString + suffix, new_string)
      } else {
        updatedFile = replaceFunc(originalFile, normalizedOldString, new_string)
      }
    } else {
      updatedFile = replaceFunc(originalFile, normalizedOldString, normalizedNewString)
    }
    if (updatedFile === originalFile) {
      throw new Error(
        'Original and edited file match exactly. Failed to apply edit.',
      )
    }
  }

  const patch = getPatch({
    filePath: file_path,
    fileContents: originalFile,
    oldStr: originalFile,
    newStr: updatedFile,
  })

  return { patch, updatedFile }
}
