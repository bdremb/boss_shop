const MAX_SOURCE = 10 * 1024 * 1024
const MAX_STORED = 600 * 1024
function imageInfo(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return {type:'png',width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)}
  if (bytes[0]===255 && bytes[1]===216) {
    let offset=2
    while(offset+4<=bytes.length) {
      if(bytes[offset++]!==255) break
      const marker=bytes[offset++]
      if(marker===0xda||marker===0xd9) break
      const length=bytes.readUInt16BE(offset)
      if(length<2||offset+length>bytes.length) break
      if([0xc0,0xc1,0xc2].includes(marker)&&length>=7) return {type:'jpeg',height:bytes.readUInt16BE(offset+3),width:bytes.readUInt16BE(offset+5)}
      offset+=length
    }
  }
  if(bytes.length>=30 && bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP') {
    const chunk=bytes.toString('ascii',12,16)
    if(chunk==='VP8X') return {type:'webp',width:1+bytes.readUIntLE(24,3),height:1+bytes.readUIntLE(27,3)}
    if(chunk==='VP8 '&&bytes[23]===0x9d&&bytes[24]===1&&bytes[25]===0x2a) return {type:'webp',width:bytes.readUInt16LE(26)&0x3fff,height:bytes.readUInt16LE(28)&0x3fff}
    if(chunk==='VP8L'&&bytes[20]===0x2f) {const bits=bytes.readUInt32LE(21);return {type:'webp',width:(bits&0x3fff)+1,height:((bits>>>14)&0x3fff)+1}}
  }
  throw new Error('Выберите корректное фото JPEG, PNG или WebP')
}
function checkDimensions(info, limit=12000) {
  if(!info.width||!info.height||info.width>limit||info.height>limit||info.width*info.height>40000000) throw new Error('Фото: максимум 12000 px по стороне и 40 мегапикселей')
}
function normalizePhoto(bytes, nativeImage) {
  if(!bytes.length||bytes.length>MAX_SOURCE) throw new Error('Фото должно быть не больше 10 МБ')
  const info=imageInfo(bytes);checkDimensions(info)
  let img=nativeImage.createFromBuffer(bytes)
  if(img.isEmpty()) throw new Error('Не удалось декодировать фото')
  checkDimensions(img.getSize())
  if(img.getSize().width!==info.width||img.getSize().height!==info.height) throw new Error('Некорректные размеры фото')
  const scale=Math.min(1,1200/Math.max(info.width,info.height))
  img=img.resize({width:Math.max(1,Math.round(info.width*scale)),height:Math.max(1,Math.round(info.height*scale)),quality:'good'})
  let encoded
  for(const quality of [85,70,55,40]) { encoded=img.toJPEG(quality);if(encoded.length<=MAX_STORED) break }
  if(!encoded.length||encoded.length>MAX_STORED) throw new Error('Не удалось сжать фото до 600 КБ; выберите другое изображение')
  return 'data:image/jpeg;base64,'+encoded.toString('base64')
}
function validatePhotoData(data) {
  if(data==='') return
  if(typeof data!=='string'||data.length>MAX_STORED*4/3+64||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('Некорректное сохранённое фото')
  const bytes=Buffer.from(data.slice(23),'base64'),info=imageInfo(bytes)
  if(info.type!=='jpeg'||bytes.length>MAX_STORED||Math.max(info.width,info.height)>1200||bytes.at(-2)!==255||bytes.at(-1)!==217) throw new Error('Некорректное сохранённое фото')
  checkDimensions(info)
}

async function preparePhoto(bytes, {nativeImage,BrowserWindow}) {
  if(!bytes.length||bytes.length>MAX_SOURCE) throw new Error('Фото должно быть не больше 10 МБ')
  const info=imageInfo(bytes);checkDimensions(info)
  if(info.type!=='webp') return normalizePhoto(bytes,nativeImage)
  // Electron 22 nativeImage only decodes JPEG/PNG on Windows. Chromium can
  // decode WebP in a separate sandbox, with no Node, paths or network access.
  const decoder=new BrowserWindow({show:false,width:100,height:100,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}})
  decoder.webContents.setWindowOpenHandler(()=>({action:'deny'}))
  let timer
  try {
    return await Promise.race([
      (async()=>{
        const html='<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:">'
        await decoder.loadURL('data:text/html;base64,'+Buffer.from(html).toString('base64'))
        const data=await decoder.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
          const img=new Image();img.onerror=()=>reject(new Error('Не удалось декодировать WebP'));
          img.onload=()=>{if(img.naturalWidth!==${info.width}||img.naturalHeight!==${info.height}){reject(new Error('Некорректные размеры WebP'));return}
            const scale=Math.min(1,1200/Math.max(img.naturalWidth,img.naturalHeight));const canvas=document.createElement('canvas');
            canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
            canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);resolve(canvas.toDataURL('image/png'))};
          img.src='data:image/webp;base64,${bytes.toString('base64')}';})`)
        return normalizePhoto(Buffer.from(data.split(',')[1],'base64'),nativeImage)
      })(),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Не удалось обработать WebP за 10 секунд')),10000)})
    ])
  } finally { clearTimeout(timer);if(!decoder.isDestroyed())decoder.destroy() }
}
module.exports={normalizePhoto,preparePhoto,validatePhotoData,imageInfo,MAX_SOURCE}
