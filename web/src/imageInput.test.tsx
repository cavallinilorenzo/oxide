// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { useImageAttachments } from "./useImageAttachments";
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
Object.assign(URL,{createObjectURL:vi.fn(()=>"blob:preview"),revokeObjectURL:vi.fn()});
const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
function Harness({context='draft'}:{context?:string}){const {images,dropRef,handlePaste,error}=useImageAttachments({enabled:true,visible:true,busy:false,context});return <div ref={dropRef}><textarea onPaste={handlePaste}/>{images.map(image=><img key={image.path} src={image.previewUrl} alt={image.name}/>)}{error&&<p role="alert">{error}</p>}</div>;}
afterEach(async()=>{await act(async()=>root.render(null));clearMocks();vi.clearAllMocks();});
function file(){const image=new File(['fixture'],'clipboard.png',{type:'image/png'});Object.defineProperty(image,'arrayBuffer',{value:async()=>new Uint8Array([137,80,78,71]).buffer});return image;}
it('pastes an image from clipboard items and previews the stored attachment',async()=>{
 const calls:string[]=[];mockIPC(command=>{calls.push(command);if(command==='save_attachment')return '/home/attachments/image.png';});
 await act(async()=>root.render(<Harness/>));
 const event=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{files:[],items:[{kind:'file',getAsFile:()=>file()}]}});
 await act(async()=>{container.querySelector('textarea')!.dispatchEvent(event);});
 expect(event.defaultPrevented).toBe(true);expect(calls).toContain('save_attachment');expect(container.querySelector('img')?.getAttribute('alt')).toBe('clipboard.png');
});
it('accepts dropped files and clears their previews when switching Threads',async()=>{
 mockIPC(command=>command==='save_attachment'?'/home/attachments/drop.png':undefined);await act(async()=>root.render(<Harness/>));
 const event=new Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{files:[file()]}});await act(async()=>{container.querySelector('textarea')!.dispatchEvent(event);});expect(container.querySelector('img')).not.toBeNull();
 await act(async()=>root.render(<Harness context="another-thread"/>));expect(container.querySelector('img')).toBeNull();expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
});
it('keeps errors visible when attachment storage fails',async()=>{
 mockIPC(command=>{if(command==='save_attachment')throw {message:'Disk is full'};});await act(async()=>root.render(<Harness/>));const event=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{files:[file()],items:[]}});await act(async()=>{container.querySelector('textarea')!.dispatchEvent(event);});expect(container.querySelector('[role="alert"]')?.textContent).toContain('Disk is full');expect(container.querySelector('img')).toBeNull();
});
