// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { TerminalInput, type TerminalInputHandle } from "./TerminalInput";
import { terminalPath } from "./terminalPaths";
import { historyMatches } from "./terminalBlocks";
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
HTMLElement.prototype.scrollIntoView=vi.fn();
const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
beforeEach(()=>{vi.stubGlobal("requestAnimationFrame",(callback:FrameRequestCallback)=>window.setTimeout(()=>callback(0),0));});
afterEach(async()=>{await act(async()=>root.render(null));clearMocks();vi.unstubAllGlobals();});
function input():HTMLTextAreaElement{return container.querySelector('textarea')!;}
async function type(value:string){await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input(),value);input().dispatchEvent(new Event('input',{bubbles:true}));});}
async function key(value:string){await act(async()=>{input().dispatchEvent(new KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true}));});}
const history=[{command:"git diff",at:1,exitCode:0},{command:"git status",at:2,exitCode:0}];
it('Up uses a prefix search while Ctrl+R supports fuzzy history search',()=>{expect(historyMatches('echo git status','git',true)).toBe(false);expect(historyMatches('git status','git',true)).toBe(true);expect(historyMatches('git status','gtst')).toBe(true);});
it('Right accepts the latest matching history entry, while Tab requests real shell completion',async()=>{
  const calls:string[]=[];mockIPC(command=>{calls.push(command);return {replacementIndex:0,replacementLength:3,matches:[{text:'git.exe',label:'git',detail:'Application'}]};});
  await act(async()=>root.render(<TerminalInput ref={createRef<TerminalInputHandle>()} history={history} sessionId={1} cwd="C:\\project" disabled={false} visible onRun={()=>{throw new Error('must not execute suggestions');}}/>));
  await type('git');await key('ArrowRight');expect(input().value).toBe('git status');expect(calls).toEqual([]);
  await type('git');await key('Tab');expect(calls).toEqual(['complete_terminal']);expect(input().value).toBe('git.exe');
});
it('Up opens searchable history and navigates older commands without executing them',async()=>{
  const run=vi.fn();await act(async()=>root.render(<TerminalInput ref={createRef<TerminalInputHandle>()} history={history} sessionId={1} cwd="/project" disabled={false} visible onRun={run}/>));
  await key('ArrowUp');expect(container.querySelector('[role="dialog"]')).not.toBeNull();expect(container.querySelector('[aria-selected="true"]')?.textContent).toContain('git status');
  await key('ArrowUp');expect(container.querySelector('[aria-selected="true"]')?.textContent).toContain('git diff');await key('Enter');expect(input().value).toBe('git diff');expect(run).not.toHaveBeenCalled();
  await key('Enter');expect(run).toHaveBeenCalledWith('git diff');
});
it('normalizes extended drive and UNC paths without losing the network share',()=>{
  expect(terminalPath('\\\\?\\C:\\work')).toBe('C:\\work');expect(terminalPath('\\\\?\\UNC\\server\\share')).toBe('\\\\server\\share');expect(terminalPath('/home/work')).toBe('/home/work');
});
