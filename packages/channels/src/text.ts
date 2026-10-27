/** Keep unquoted inline replies; forwarded attribution needs confirmation. */
export function authoredReplyView(text:string) {
  const lines=text.replace(/\r\n/g,"\n").split("\n"), authored:string[]=[];
  let forwarded=false,uncertain=false,replyHistory=false,quotedSinceHeader=false;
  for(let i=0;i<lines.length;i++) {
    const line=lines[i]!;
    if(/^\s*>/.test(line)){quotedSinceHeader=true;continue;}
    if(/^\s*-{2,}\s*(Original Message|Forwarded message)/i.test(line)) {forwarded=true;continue;}
    if(/^\s*On\s/.test(line)&&lines.slice(i,i+4).join(" ").includes("wrote:")) {
      replyHistory=true;quotedSinceHeader=false;
      while(i<lines.length-1&&!/wrote:\s*$/.test(lines[i]!))i++;continue;
    }
    if((forwarded || (replyHistory&&!quotedSinceHeader)) && line.trim())uncertain=true;
    authored.push(line);
  }
  return {text:authored.join("\n").trim(),uncertain};
}
export function authoredReplyText(text:string) {return authoredReplyView(text).text;}
