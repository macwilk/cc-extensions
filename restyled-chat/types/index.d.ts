export type CopiedBlock = string

declare module 'claude-code' {
  interface PluginState {
    'restyled-chat': { copiedBlock: StateFamily<CopiedBlock> }
  }
}
