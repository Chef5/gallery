const express = require("express");
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsCommand,
  HeadObjectCommand,
} = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const sharp = require("sharp");
const dotenv = require("dotenv");
const path = require("path");
const exifParser = require("exif-parser");
const imageList = require("./data.json");

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// 存储所有的SSE客户端连接
const clients = [];

// 用于发送通知消息到所有连接的客户端
function sendNotification(message) {
  console.log(`通知消息: ${message}`);
  const notification = JSON.stringify({ message });

  // 发送到所有客户端
  clients.forEach((client) => {
    try {
      client.write(`data: ${notification}\n\n`);
    } catch (error) {
      console.error("发送通知失败:", error);
    }
  });
}

// SSE endpoint
app.get("/notifications", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  const clientId = Date.now();
  clients.push(res);

  console.log(`客户端连接到通知服务: ${clientId}`);

  // 当客户端断开连接时移除它
  req.on("close", () => {
    console.log(`客户端断开连接: ${clientId}`);
    const index = clients.indexOf(res);
    if (index !== -1) {
      clients.splice(index, 1);
    }
  });
});

const s3Client = new S3Client({
  region: process.env.R2_REGION,
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  tls: true,
});

const BUCKET_NAME = process.env.R2_BUCKET_NAME;
const IMAGE_BASE_URL = process.env.R2_IMAGE_BASE_URL;
const IMAGE_DIR = process.env.R2_IMAGE_DIR;
const IMAGE_COMPRESSION_QUALITY = parseInt(
  process.env.IMAGE_COMPRESSION_QUALITY,
  10
);

const validImageExtensions = [".jpg", ".jpeg", ".png", ".gif"];

async function getExifData(key) {
  try {
    console.log(`获取EXIF数据: ${key}`);
    const getObjectParams = {
      Bucket: BUCKET_NAME,
      Key: key,
    };

    // 添加超时处理
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("获取图片数据超时")), 5000);
    });

    // 获取图片数据，添加超时限制
    const imageBufferPromise = s3Client
      .send(new GetObjectCommand(getObjectParams))
      .then((response) => {
        return new Promise((resolve, reject) => {
          const chunks = [];
          response.Body.on("data", (chunk) => chunks.push(chunk));
          response.Body.on("end", () => resolve(Buffer.concat(chunks)));
          response.Body.on("error", reject);
        });
      });

    // 使用 Promise.race 确保请求不会挂起太久
    const imageBuffer = await Promise.race([
      imageBufferPromise,
      timeoutPromise,
    ]);

    // 添加错误处理
    try {
      // 检查图片格式是否支持EXIF
      const isJpeg =
        key.toLowerCase().endsWith(".jpg") ||
        key.toLowerCase().endsWith(".jpeg");
      if (!isJpeg) {
        console.log(`图片格式不支持EXIF: ${key}`);
        return {
          FNumber: null,
          ExposureTime: null,
          ISO: null,
        };
      }

      const parser = exifParser.create(imageBuffer);
      const exifData = parser.parse().tags;

      // 返回整理后的EXIF数据
      return {
        FNumber: exifData.FNumber
          ? parseFloat(exifData.FNumber.toFixed(1))
          : null,
        ExposureTime: exifData.ExposureTime
          ? parseFloat(exifData.ExposureTime.toFixed(4))
          : null,
        ISO: exifData.ISO || null,
      };
    } catch (exifError) {
      console.warn(`无法解析EXIF数据(${key}): ${exifError.message}`);
      return {
        FNumber: null,
        ExposureTime: null,
        ISO: null,
      };
    }
  } catch (error) {
    console.error(`获取图片EXIF数据失败(${key}): ${error.message}`);
    // 返回空数据但不影响整体流程
    return {
      FNumber: null,
      ExposureTime: null,
      ISO: null,
      error: error.message,
    };
  }
}

app.use(express.static("public"));
app.get("/images", async (req, res) => {
  try {
    console.log("获取图片列表...");
    const result = {};

    // 遍历 imageList 中的每个日期和对应的图片列表
    for (const [date, images] of Object.entries(imageList)) {
      result[date] = images.map((image) => ({
        original: `${IMAGE_BASE_URL}/${image}`,
        thumbnail: `${IMAGE_BASE_URL}/${image}?imageView2/2/w/200/h/400/format/webp/q/${IMAGE_COMPRESSION_QUALITY}`,
      }));
    }

    console.log("图片列表已发送到客户端");
    res.json(result);
  } catch (error) {
    console.error("获取图片列表失败:", error);
    res.status(500).send("获取图片列表失败");
  }
});

app.get("/thumbnail/:key", async (req, res) => {
  const key = decodeURIComponent(req.params.key);
  console.log(`请求缩略图: ${key}`);
  // https://developer.qiniu.com/dora/api/basic-processing-images-imageview2
  return `${IMAGE_BASE_URL}/${item.Key}?imageView2/2/w/200/h/400/format/webp/q/${IMAGE_COMPRESSION_QUALITY}`;
});

app.get("/exif/:key", async (req, res) => {
  const key = decodeURIComponent(req.params.key);
  console.log(`请求EXIF数据: ${key}`);

  // 处理相对路径，确保我们有完整的存储桶路径
  let processedKey = key;
  if (key.startsWith(IMAGE_BASE_URL)) {
    // 如果是完整URL，提取路径部分
    processedKey = key.replace(IMAGE_BASE_URL + "/", "");
    console.log(`从完整URL提取路径: ${processedKey}`);
  }

  try {
    console.log(`处理的EXIF路径: ${processedKey}`);
    const exifData = await getExifData(processedKey);
    console.log(`EXIF数据获取成功: ${JSON.stringify(exifData)}`);
    res.json(exifData);
  } catch (error) {
    console.error(`获取EXIF数据失败(${processedKey}): ${error.message}`, error);
    console.error(`错误栈: ${error.stack}`);
    res.status(500).json({
      error: error.message,
      FNumber: null,
      ExposureTime: null,
      ISO: null,
    });
  }
});

app.get("/config", (req, res) => {
  res.json({ IMAGE_BASE_URL: process.env.R2_IMAGE_BASE_URL });
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
