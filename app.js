require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const cors = require("cors");
const AWS = require("aws-sdk");

const app = express();
const port = 3000;

// Configure AWS SDK
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME;
console.log("USING AWS");

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const fileTypes = /jpeg|jpg|png|gif|mp4|avi|mov|wmv/;
    const mimeType = fileTypes.test(file.mimetype);
    const extname = fileTypes.test(
      path.extname(file.originalname).toLowerCase()
    );
    if (mimeType && extname) {
      return cb(null, true);
    }
    cb(new Error("Only images and video files are allowed"));
  },
});

const getBlogs = async () => {
  try {
    const params = { Bucket: BUCKET_NAME, Key: "blogs.json" };
    const data = await s3.getObject(params).promise();
    return JSON.parse(data.Body.toString("utf-8"));
  } catch (err) {
    if (err.code === "NoSuchKey") {
      return [];
    }
    console.error("Error reading or parsing blogs.json:", err);
    return [];
  }
};

const writeBlogs = async (blogs) => {
  try {
    const params = {
      Bucket: BUCKET_NAME,
      Key: "blogs.json",
      Body: JSON.stringify(blogs, null, 2),
      ContentType: "application/json",
    };
    await s3.putObject(params).promise();
  } catch (err) {
    console.error("Error writing to blogs.json:", err);
    throw err;
  }
};

const generateId = (title) => {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "-");
};

app.get("/blog/:id", async (req, res) => {
  const { id } = req.params;
  const blogs = await getBlogs();
  const blog = blogs.find((blog) => blog.id === id);

  if (!blog) {
    return res.status(404).json({ error: "Blog post not found" });
  }

  res.json(blog);
});

app.get("/blog", async (req, res) => {
  const blogs = await getBlogs();
  res.json(blogs);
});

app.post("/blog", upload.single("file"), async (req, res) => {
  const { title, content } = req.body;

  if (!title || !content) {
    return res
      .status(400)
      .json({ error: "Both title and content are required" });
  }

  const blogs = await getBlogs();
  const id = generateId(title);

  if (blogs.some((blog) => blog.id === id)) {
    return res
      .status(409)
      .json({ error: "A blog post with this title already exists" });
  }

  let fileUrl = null;
  if (req.file) {
    const params = {
      Bucket: BUCKET_NAME,
      Key: `files/${id}${path.extname(req.file.originalname)}`,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    };
    const data = await s3.upload(params).promise();
    fileUrl = data.Location;
  }

  const newBlog = { id, title, content, file: fileUrl };
  blogs.push(newBlog);

  try {
    await writeBlogs(blogs);
    res.status(201).json(newBlog);
  } catch (err) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.delete("/blog/:id", async (req, res) => {
  const { id } = req.params;
  const blogs = await getBlogs();
  const blogIndex = blogs.findIndex((blog) => blog.id === id);

  if (blogIndex === -1) {
    return res.status(404).json({ error: "Blog post not found" });
  }

  const blogToDelete = blogs[blogIndex];
  if (blogToDelete.file) {
    const fileKey = blogToDelete.file.split("/").pop();
    const params = { Bucket: BUCKET_NAME, Key: `files/${fileKey}` };
    await s3.deleteObject(params).promise();
  }

  blogs.splice(blogIndex, 1);

  try {
    await writeBlogs(blogs);
    res.status(200).json({ message: "Blog post deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.put("/blog/:id", upload.single("file"), async (req, res) => {
  const { id } = req.params;
  const { title, content } = req.body;
  const blogs = await getBlogs();
  const blogIndex = blogs.findIndex((blog) => blog.id === id);

  if (blogIndex === -1) {
    return res.status(404).json({ error: "Blog post not found" });
  }

  const currentBlog = blogs[blogIndex];
  let newId = id;
  if (title) {
    newId = generateId(title);
    if (newId !== id && blogs.some((blog) => blog.id === newId)) {
      return res
        .status(409)
        .json({ error: "A blog post with this title already exists" });
    }
    currentBlog.title = title;
  }

  if (content) {
    currentBlog.content = content;
  }

  let fileUrl = currentBlog.file;
  if (req.file) {
    if (fileUrl) {
      const oldFileKey = fileUrl.split("/").pop();
      const params = { Bucket: BUCKET_NAME, Key: `files/${oldFileKey}` };
      await s3.deleteObject(params).promise();
    }
    const params = {
      Bucket: BUCKET_NAME,
      Key: `files/${newId}${path.extname(req.file.originalname)}`,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    };
    const data = await s3.upload(params).promise();
    fileUrl = data.Location;
    currentBlog.file = fileUrl;
  }

  blogs[blogIndex] = { ...currentBlog, id: newId };

  try {
    await writeBlogs(blogs);
    res.status(200).json(blogs[blogIndex]);
  } catch (err) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
