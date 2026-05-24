(function () {
  const MAX_EDGE = 1800;
  const TARGET_BYTES = 900 * 1024;
  const MIN_QUALITY = 0.62;

  function isImage(file) {
    return file && /^image\//i.test(file.type || "");
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("\u56fe\u7247\u8bfb\u53d6\u5931\u8d25"));
      };
      img.src = url;
    });
  }

  function canvasToBlob(canvas, quality) {
    return new Promise((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", quality);
    });
  }

  async function compressImage(file) {
    if (!isImage(file)) {
      return file;
    }

    if (file.size <= TARGET_BYTES && file.type !== "image/png") {
      return file;
    }

    const img = await loadImage(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    let bestBlob = null;
    for (const quality of [0.86, 0.78, 0.7, MIN_QUALITY]) {
      const blob = await canvasToBlob(canvas, quality);
      if (!blob) continue;
      bestBlob = blob;
      if (blob.size <= TARGET_BYTES) break;
    }

    if (!bestBlob || bestBlob.size >= file.size) {
      return file;
    }

    const baseName = file.name.replace(/\.[^.]+$/, "");
    return new File([bestBlob], `${baseName || "receipt"}.jpg`, {
      type: "image/jpeg",
      lastModified: Date.now()
    });
  }

  const originalUploadReceipt = window.uploadReceipt;
  window.uploadReceipt = async function (file) {
    if (!file) return null;
    const uploadFile = await compressImage(file);
    if (uploadFile !== file && typeof showMessage === "function") {
      const before = (file.size / 1024 / 1024).toFixed(2);
      const after = (uploadFile.size / 1024 / 1024).toFixed(2);
      showMessage(`\u51ed\u8bc1\u56fe\u7247\u5df2\u81ea\u52a8\u538b\u7f29\uff1a${before}MB -> ${after}MB`);
    }

    if (typeof originalUploadReceipt === "function") {
      return originalUploadReceipt(uploadFile);
    }

    const cleanName = uploadFile.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${state.user.id}/${Date.now()}-${cleanName}`;
    const { error } = await state.supabase.storage.from(RECEIPT_BUCKET).upload(path, uploadFile, {
      upsert: false,
      contentType: uploadFile.type || undefined
    });
    if (error) throw error;
    return path;
  };
})();
