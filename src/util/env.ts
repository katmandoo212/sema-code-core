
import { memoize } from 'lodash-es'
import os from 'os'
import { getIsGit } from './git'
import { getOriginalCwd } from './cwd'
import { IS_WIN, IS_MAC } from './platform'

export const env = {
  platform: IS_WIN ? 'windows' : IS_MAC ? 'macos' : 'linux',
}

export const getEnv = memoize(async (): Promise<string> => {
  const cwd = getOriginalCwd()
  const isGitRepo = await getIsGit()
  const osVersion = os.release()
  const today = new Date().toISOString().split('T')[0]

  return `Working directory: ${cwd}
Is directory a git repo: ${isGitRepo ? 'Yes' : 'No'}
Platform: ${process.platform}
OS Version: ${os.type()} ${osVersion}
Today's date: ${today}`
})
