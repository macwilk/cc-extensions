export type IsOpen = boolean

declare module 'claude-code' {
  interface PluginState {
    'cleaner-tool-lines': { isOpen: StateFamily<IsOpen> }
  }
}
