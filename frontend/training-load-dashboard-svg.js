// Parse off-document; never put an untrusted live SVG into the report's innerHTML.
const SVG_NS='http://www.w3.org/2000/svg';
const ELEMENTS=new Set(['svg','g','defs','clipPath','rect','path','line','polyline','polygon','circle','ellipse','text','tspan','linearGradient','radialGradient','stop']);
const ATTRIBUTES=new Set(['xmlns','viewBox','width','height','preserveAspectRatio','id','clip-path','fill','stroke','fill-opacity','stroke-opacity','opacity','fill-rule','clip-rule','d','points','x','y','dx','dy','x1','y1','x2','y2','cx','cy','r','rx','ry','transform','gradientUnits','gradientTransform','offset','stop-color','stop-opacity','text-anchor','dominant-baseline','font-family','font-size','font-weight','font-style','lengthAdjust','textLength','stroke-width','stroke-linecap','stroke-linejoin','stroke-dasharray','stroke-dashoffset','paint-order']);
const STYLES=new Set(['font-size','font-family','font-weight','font-style','text-anchor','dominant-baseline','alignment-baseline','opacity','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','stroke-dasharray','visibility','display']);
const localReference=value=>/^url\(\s*['"]?#[A-Za-z0-9_.:-]+['"]?\s*\)$/i.test(value);
const safeValue=value=>!/(?:url\s*\(|expression\s*\(|javascript\s*:|data\s*:|https?\s*:|@import|\/\/)/i.test(value)||localReference(value);
export function prepareReportSvg(source,target){
 if(typeof source!=='string'||/<!DOCTYPE|<!ENTITY|<\?/i.test(source))throw Error('A chart could not be prepared. Try PDF again.');
 const Parser=target.defaultView?.DOMParser;
 if(!Parser)throw Error('A chart could not be prepared. Try PDF again.');
 const document=new Parser().parseFromString(source,'image/svg+xml'),root=document.documentElement;
 if(document.querySelector('parsererror')||root.localName!=='svg'||root.namespaceURI!==SVG_NS)throw Error('A chart could not be prepared. Try PDF again.');
 for(const node of [root,...root.querySelectorAll('*')]){
  if(node.namespaceURI!==SVG_NS||!ELEMENTS.has(node.localName)){node.remove();continue;}
  const styles=[];
  for(const property of Array.from(node.style??[])){
   const value=node.style.getPropertyValue(property);
   if(STYLES.has(property)&&safeValue(value))styles.push([property,value]);
  }
  for(const attr of [...node.attributes]){
   const definitionId=attr.name==='id'&&['clipPath','linearGradient','radialGradient'].includes(node.localName)&&/^[A-Za-z0-9_.:-]+$/.test(attr.value);
   if(!ATTRIBUTES.has(attr.name)||(!(attr.name==='xmlns'&&attr.value===SVG_NS)&&!safeValue(attr.value))||(attr.name==='id'&&!definitionId))node.removeAttribute(attr.name);
  }
  node.removeAttribute('style');
  for(const [property,value]of styles)node.style.setProperty(property,value);
 }
 return target.importNode(root,true);
}