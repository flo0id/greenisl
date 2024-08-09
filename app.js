const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const cors = require("cors"); // Import the cors package

const app = express();
const port = 3000;

// Use cors middleware to allow CORS from any origin
app.use(cors());

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Ensure /files directory exists
const filesDir = path.join(__dirname, "files");
if (!fs.existsSync(filesDir)) {
  fs.mkdirSync(filesDir);
}

// Configure multer to save files in /files with the blog's id as the filename
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, filesDir); // Save files to /files directory
  },
  filename: (req, file, cb) => {
    // Generate filename based on blog ID or title if provided
    const blogId =
      req.params.id ||
      req.body.title
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .trim()
        .replace(/\s+/g, "-");
    const ext = path.extname(file.originalname);
    cb(null, `${blogId}${ext}`); // Save file with blog ID as filename
  },
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // Set file size limit to 50MB
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

// Middleware to parse JSON request bodies
app.use(express.json());

// Helper function to get blogs data
const getBlogs = (filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, "utf8");
      if (data.trim()) {
        return JSON.parse(data);
      }
    }
    return [];
  } catch (err) {
    console.error("Error reading or parsing blogs.json:", err);
    return [];
  }
};

// Helper function to write blogs data
const writeBlogs = (filePath, blogs) => {
  try {
    fs.writeFileSync(filePath, JSON.stringify(blogs, null, 2));
  } catch (err) {
    console.error("Error writing to blogs.json:", err);
    throw err;
  }
};

// Helper function to generate a unique ID based on the title
const generateId = (title) => {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "-");
};

// Endpoint to get a blog post by id
app.get("/blog/:id", (req, res) => {
  const filePath = path.join(__dirname, "blogs.json");
  const { id } = req.params;

  const blogs = getBlogs(filePath);
  const blog = blogs.find((blog) => blog.id === id);

  if (!blog) {
    return res.status(404).json({ error: "Blog post not found" });
  }

  res.json(blog);
});

// Endpoint to get the blog data
app.get("/blog", (req, res) => {
  const filePath = path.join(__dirname, "blogs.json");
  const blogs = getBlogs(filePath);
  res.json(blogs);
});

// Endpoint to add a new blog post
app.post("/blog", upload.single("file"), (req, res) => {
  const filePath = path.join(__dirname, "blogs.json");
  const { title, content } = req.body;

  if (!title || !content) {
    return res
      .status(400)
      .json({ error: "Both title and content are required" });
  }

  const blogs = getBlogs(filePath);
  const id = generateId(title);

  if (blogs.some((blog) => blog.id === id)) {
    return res
      .status(409)
      .json({ error: "A blog post with this title already exists" });
  }

  // Handle file upload
  let fileUrl = null;
  if (req.file) {
    fileUrl = `/files/${req.file.filename}`;
  }

  const newBlog = { id, title, content, file: fileUrl };
  blogs.push(newBlog);

  try {
    writeBlogs(filePath, blogs);
    res.status(201).json(newBlog);
  } catch (err) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Endpoint to delete a blog post by id
app.delete("/blog/:id", (req, res) => {
  const filePath = path.join(__dirname, "blogs.json");
  const { id } = req.params;

  const blogs = getBlogs(filePath);
  const blogIndex = blogs.findIndex((blog) => blog.id === id);

  if (blogIndex === -1) {
    return res.status(404).json({ error: "Blog post not found" });
  }

  // Delete associated file if it exists
  const blogToDelete = blogs[blogIndex];
  if (blogToDelete.file) {
    const fileToDelete = path.join(__dirname, blogToDelete.file);
    if (fs.existsSync(fileToDelete)) {
      fs.unlinkSync(fileToDelete);
    }
  }

  blogs.splice(blogIndex, 1);

  try {
    writeBlogs(filePath, blogs);
    res.status(200).json({ message: "Blog post deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Endpoint to edit an existing blog post by id
// Endpoint to edit an existing blog post by id
app.put("/blog/:id", upload.single("file"), (req, res) => {
  const filePath = path.join(__dirname, "blogs.json");
  const { id } = req.params;
  const { title, content } = req.body;

  const blogs = getBlogs(filePath);
  const blogIndex = blogs.findIndex((blog) => blog.id === id);

  if (blogIndex === -1) {
    return res.status(404).json({ error: "Blog post not found" });
  }

  const currentBlog = blogs[blogIndex];

  // Update title and regenerate ID if the title has changed
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

  // Update content if provided
  if (content) {
    currentBlog.content = content;
  }

  // Handle file upload
  let fileUrl = currentBlog.file;
  if (req.file) {
    // Delete the old file if a new one is uploaded
    if (fileUrl) {
      const oldFilePath = path.join(__dirname, fileUrl);
      if (fs.existsSync(oldFilePath)) {
        fs.unlinkSync(oldFilePath);
      }
    }
    const ext = path.extname(req.file.originalname);
    const newFileName = `${newId}${ext}`;
    fileUrl = `/files/${newFileName}`;
    fs.renameSync(req.file.path, path.join(__dirname, "files", newFileName));
    currentBlog.file = fileUrl;
  }

  // Update the blog post in the list
  blogs[blogIndex] = { ...currentBlog, id: newId };

  try {
    writeBlogs(filePath, blogs);
    res.status(200).json(blogs[blogIndex]);
  } catch (err) {
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Serve static files in the /files folder
app.use("/files", express.static(filesDir));

// Start the server
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
