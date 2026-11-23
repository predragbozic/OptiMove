// ECharts options consume only server-confirmed projections. Internal athlete,
// series and bucket keys are resolved here and never serialized into chart DOM.
export function galleryChartPlot(data, {
  seriesLabel=()=> 'Measurement',athleteLabel=()=> 'Athlete name unavailable',
  bucketLabel=()=> 'Group',legendVisible=true,valueLabelsVisible=false,precision=2,bindings=[],
}={}) {
  if(!data || !['ready','partial'].includes(data.status) || !data.groups?.length)return null;
  const distinctNames = (keys,label) => {
    const used=new Set(),map=new Map();
    for(const key of keys){const base=label(key)||'Athlete name unavailable';let name=base,n=2;while(used.has(name))name=base+' ('+n+++')';used.add(name);map.set(key,name);}
    return map;
  };
  const bucketKeys=[...new Set(data.groups.map(g=>g.bucketKey))].sort();
  const bucketNames=new Map(bucketKeys.map(key=>[key,bucketLabel(key)]));
  const athleteKeys=[...new Set(data.groups.map(g=>g.athleteId).filter(Boolean))];
  const names=distinctNames(athleteKeys,athleteLabel);
  const definitions=data.series??[],label=n=>seriesLabel(definitions[n]?.seriesId)||'Measurement';
  const option={animation:false,grid:{left:12,right:24,top:48,bottom:12,containLabel:true},
    legend:{show:legendVisible,type:'scroll',top:4},tooltip:{trigger:'axis',renderMode:'richText',confine:true},
    xAxis:{type:'category',data:bucketKeys.map(k=>bucketNames.get(k)),axisLabel:{hideOverlap:true}},
    yAxis:{type:'value',name:definitions[0]?.unit??''},series:[]};
  const plot={caption:definitions.map((_,n)=>label(n)).join(' · '),precision,shortDateAxis:true,option};
  if(data.kind==='scatter'){
    option.tooltip.trigger='item';plot.shortDateAxis=false;
    option.xAxis={type:'value',name:[label(0),definitions[0]?.unit].filter(Boolean).join(' (')+(definitions[0]?.unit?')':'')};
    option.yAxis={type:'value',name:[label(1),definitions[1]?.unit].filter(Boolean).join(' (')+(definitions[1]?.unit?')':'')};
    option.series=athleteKeys.map((athlete,index)=>({id:String(index),name:names.get(athlete),type:'scatter',
      data:data.groups.filter(g=>g.athleteId===athlete).map(g=>({name:bucketNames.get(g.bucketKey),value:[...g.values]}))}));
    // A pooled (non-athlete) query still has a named series without an internal key.
    if(!athleteKeys.length)option.series=[{name:plot.caption,type:'scatter',data:data.groups.map(g=>({name:bucketNames.get(g.bucketKey),value:[...g.values]}))}];
    return plot;
  }
  if(data.kind==='heatmap'){
    plot.shortDateAxis=true;option.tooltip.trigger='item';option.legend.show=false;
    option.yAxis={type:'category',data:athleteKeys.map(k=>names.get(k))};
    const values=data.groups.map(g=>g.values[0]),min=Math.min(...values),max=Math.max(...values);
    option.visualMap={min,max:max===min?min+1:max,calculable:false,orient:'horizontal',left:'center',bottom:0,text:[definitions[0]?.unit??'','']};
    option.grid.bottom=56;
    option.series=[{name:label(0),type:'heatmap',label:{show:valueLabelsVisible},
      data:data.groups.map(g=>[bucketKeys.indexOf(g.bucketKey),athleteKeys.indexOf(g.athleteId),g.values[0]])}];
    return plot;
  }
  if(data.kind==='boxplot'){
    const boxes=new Map(data.groups.map(g=>[g.bucketKey,g]));
    option.series=[{name:label(0),type:'boxplot',data:bucketKeys.map(k=>({name:bucketNames.get(k)+' · '+boxes.get(k).count+' values',value:[...boxes.get(k).box]}))},
      {name:'Outliers',type:'scatter',data:bucketKeys.flatMap((k,n)=>boxes.get(k).outliers.map(value=>[n,value]))}];
    return plot;
  }
  const athletes=athleteKeys.length?athleteKeys:[null],used=new Set();
  for(let index=0;index<definitions.length;index++)for(let athleteIndex=0;athleteIndex<athletes.length;athleteIndex++){
    const athlete=athletes[athleteIndex],rows=new Map(data.groups.filter(g=>(g.athleteId??null)===athlete).map(g=>[g.bucketKey,g]));
    const binding=bindings.find(b=>b.seriesId===definitions[index].seriesId);
    const base=[label(index),athlete?names.get(athlete):null].filter(Boolean).join(' · ');let name=base,n=2;while(used.has(name))name=base+' ('+n+++')';used.add(name);
    const type=data.kind==='combined'?binding?.mark:data.kind==='area'?'line':'bar';
    option.series.push({id:String(option.series.length),name,type,connectNulls:false,
      ...(data.kind==='area'?{areaStyle:{opacity:.2}}:{}),
      ...(data.kind==='stacked'?{stack:String(athleteIndex)}:{}),
      ...(data.kind==='combined'?{yAxisIndex:binding?.axis??0}:{}),
      label:{show:valueLabelsVisible},data:bucketKeys.map(k=>rows.get(k)?.values[index]??null)});
  }
  if(data.kind==='combined'){
    option.yAxis=[0,1].map(axis=>({type:'value',name:definitions.find(d=>bindings.some(b=>b.seriesId===d.seriesId&&b.axis===axis))?.unit??'',position:axis?'right':'left'}));
  }
  if(data.kind==='horizontal_bar'){
    [option.xAxis,option.yAxis]=[option.yAxis,option.xAxis];plot.shortDateAxis=false;plot.shortDateCategoryAxis='y';
  }
  return plot;
}
