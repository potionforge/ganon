function calculateByteLength(str: string | null | undefined): number {
  if (str === null || str === undefined) {
    return 0;
  }
  
  let length = 0;
  for (let i = 0; i < str.length; i++) {
    const charCode = str.charCodeAt(i);
    if (charCode < 0x0080) {
      length += 1;
    } else if (charCode < 0x0800) {
      length += 2;
    } else if (charCode < 0x10000) {
      length += 3;
    } else {
      length += 4;
    }
  }
  return length;
}

export default calculateByteLength;
