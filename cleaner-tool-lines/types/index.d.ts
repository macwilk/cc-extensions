export type IsOpen = boolean

declare module 'claude-code' {
  interface PluginState {
    'cleaner-tool-lines': {
      isOpen: StateFamily<IsOpen>
      isSpreeOpen: StateFamily<IsOpen>
      spreeChanges: StateFamily<number>
      thoughtSplitsSeen: string[]
    }
  }
}
