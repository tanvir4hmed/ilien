/** Opens a readable, visual-only map preview without changing the live map. */
export function openMapPreview(canvas: HTMLElement, title: string) {
  const dialog=document.createElement('dialog');dialog.className='map-preview';
  const heading=document.createElement('h2');heading.textContent=title;
  const close=document.createElement('button');close.type='button';close.textContent='Close';close.onclick=()=>dialog.close();
  const toolbar=document.createElement('div');toolbar.className='map-preview-tools';toolbar.append(heading,close);
  const viewport=document.createElement('div');viewport.className='map-preview-viewport';
  const copy=canvas.cloneNode(true) as HTMLElement;copy.style.zoom='1';copy.querySelectorAll('button').forEach(button=>button.tabIndex=-1);viewport.append(copy);
  dialog.append(toolbar,viewport);dialog.addEventListener('close',()=>dialog.remove());document.body.append(dialog);dialog.showModal();
  const fit=()=>{const width=parseFloat(canvas.style.width),height=parseFloat(canvas.style.height);const scale=Math.min(1,(viewport.clientWidth-36)/width,(viewport.clientHeight-36)/height);copy.style.zoom=String(Math.max(.1,scale));};
  requestAnimationFrame(fit);const observer=new ResizeObserver(fit);observer.observe(viewport);dialog.addEventListener('close',()=>observer.disconnect(),{once:true});
}
