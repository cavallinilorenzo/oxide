/** The question ⌘Q asks while Threads are working or need input. */
export function quitPrompt(running: number): string {
  return `Quit and interrupt ${running} ${running === 1 ? "Thread" : "Threads"}?`;
}
