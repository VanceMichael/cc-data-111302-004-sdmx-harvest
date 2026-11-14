// 受限 XML 子集解析器：只处理交换约定中的元素、属性、文本与自闭合标签。
// 不引入外部依赖；命名空间、DTD、CDATA 等超出本交换约定的内容直接报错。

class XmlError extends Error {}

function decodeEntities(text){
  return text
    .replaceAll('&lt;','<')
    .replaceAll('&gt;','>')
    .replaceAll('&quot;','"')
    .replaceAll('&apos;',"'")
    .replaceAll('&amp;','&');
}

function tokenize(xml){
  const tokens=[];
  let i=0;
  const n=xml.length;
  while(i<n){
    if(xml[i]!=='<'){
      const next=xml.indexOf('<',i);
      const end=next===-1?n:next;
      const text=xml.slice(i,end).trim();
      if(text)tokens.push({type:'text',value:decodeEntities(text)});
      i=end;
      continue;
    }
    if(xml.startsWith('<!--',i)){
      const close=xml.indexOf('-->',i+4);
      if(close===-1)throw new XmlError('XML注释未闭合');
      i=close+3;
      continue;
    }
    if(xml.startsWith('<?',i)){
      const close=xml.indexOf('?>',i+2);
      if(close===-1)throw new XmlError('XML声明未闭合');
      i=close+2;
      continue;
    }
    if(xml.startsWith('<!',i))throw new XmlError('不支持的XML声明结构');
    const close=xml.indexOf('>',i+1);
    if(close===-1)throw new XmlError('XML标签未闭合');
    let raw=xml.slice(i+1,close);
    const selfClosing=raw.endsWith('/');
    if(selfClosing)raw=raw.slice(0,-1).trimEnd();
    const parts=raw.match(/(?:[^\s"]+|"[^"]*")+/g)??[];
    const name=parts.shift();
    if(!name)throw new XmlError('XML标签缺少名称');
    const attributes={};
    for(const part of parts){
      const eq=part.indexOf('=');
      if(eq===-1)throw new XmlError(`标签 ${name} 存在无值属性`);
      const attrName=part.slice(0,eq);
      let attrValue=part.slice(eq+1);
      if(attrValue.startsWith('"')&&attrValue.endsWith('"'))attrValue=attrValue.slice(1,-1);
      attributes[attrName]=decodeEntities(attrValue);
    }
    tokens.push({type:'tag',name,attributes,selfClosing});
    i=close+1;
  }
  return tokens;
}

export function parseXml(xml){
  const tokens=tokenize(xml);
  const root={name:null,attributes:{},children:[],text:''};
  const stack=[root];
  for(const token of tokens){
    const current=stack[stack.length-1];
    if(token.type==='text'){
      current.text+=(current.text?' ':'')+token.value;
      continue;
    }
    if(token.name.startsWith('/')){
      const tagName=token.name.slice(1);
      if(current.name!==tagName)throw new XmlError(`XML闭合标签不匹配: 期望 ${current.name}，实际 ${tagName}`);
      stack.pop();
      continue;
    }
    const node={name:token.name,attributes:token.attributes,children:[],text:''};
    current.children.push(node);
    if(!token.selfClosing)stack.push(node);
  }
  if(stack.length!==1)throw new XmlError('XML存在未闭合的标签');
  const elements=root.children.filter(node=>node.type!=='text');
  if(elements.length!==1)throw new XmlError('XML必须只有一个根元素');
  return elements[0];
}

export function children(node,name){
  return node.children.filter(child=>child.name===name);
}
