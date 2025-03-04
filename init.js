const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");
const qiniu = require("qiniu");

dotenv.config();

const BUCKET_NAME = process.env.R2_BUCKET_NAME;
const IMAGE_DIR = process.env.R2_IMAGE_DIR;

// 七牛云
const mac = new qiniu.auth.digest.Mac(
  process.env.R2_ACCESS_KEY_ID,
  process.env.R2_SECRET_ACCESS_KEY
);
const config = new qiniu.conf.Config();
config.useHttpsDomain = true;
const bucketManager = new qiniu.rs.BucketManager(mac, config);
const listOptions = {
  limit: 1000,
  prefix: IMAGE_DIR,
  marker: "",
  isFirst: true, // 是否是第一次调用
};

const validImageExtensions = [".jpg", ".jpeg", ".png", ".gif"];

const getList = async () => {
  if (listOptions.isFirst === false && !listOptions.marker) {
    return Promise.resolve([]);
  }
  listOptions.isFirst = false;
  try {
    const data = await bucketManager
      .listPrefix(BUCKET_NAME, listOptions)
      .then(({ data, resp }) => {
        if (resp.statusCode === 200) {
          //如果这个nextMarker不为空，那么还有未列举完毕的文件列表
          nextMarker = data.marker;
          listOptions.marker = nextMarker;
          const items = data.items;
          const keys = items
            .filter((item) => {
              const itemExtension = path.extname(item.key).toLowerCase();
              const isValidImage = validImageExtensions.includes(itemExtension);
              return isValidImage;
            })
            .map((item) => item.key);
          return Promise.resolve(keys);
        } else {
          console.log(resp);
          return Promise.reject(resp);
        }
      });
    return Promise.resolve(data);
  } catch (error) {
    return Promise.resolve([]);
  }
};

const getAllData = async () => {
  const list = [];
  console.log("递归查询开始");
  const deepFetch = async () => {
    const data = await getList();
    // console.log("list length", data.length);
    // console.log("  next marker", listOptions.marker);
    list.push(...data);
    if (data.length === 0) {
      return Promise.resolve(list);
    }
    return deepFetch();
  };
  await deepFetch();
  console.log("递归结束");
  console.log(list.length);
  return list;
};

const dataFormat = (list) => {
  // 按文件夹分类图片
  const imageMap = new Map();
  list.forEach((item) => {
    const parts = item.split("/");
    const folder = parts.length > 2 ? parts[1] : "root";
    if (!imageMap.has(folder)) {
      imageMap.set(folder, []);
    }
    imageMap.get(folder).push(item);
  });

  const result = {};
  for (const [folder, images] of imageMap.entries()) {
    result[folder] = images;
    console.log(`文件夹 "${folder}" 包含 ${images.length} 张图片`);
  }

  return result;
};

const currentDir = __dirname;
const filePath = path.join(currentDir, "data.json");
const init = async () => {
  const list = await getAllData();
  const result = dataFormat(list);
  // 开发预览：使用缩进美化 JSON 格式
  //   const jsonData = JSON.stringify(result, null, 2);
  // 正式运行：不缩进，减少文件大小
  const jsonData = JSON.stringify(result, null);
  fs.writeFileSync(filePath, jsonData, "utf8");
};

init();
