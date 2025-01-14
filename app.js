require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const cors = require("cors");
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const jwt = require("jsonwebtoken");
const authMiddleware = require("./authMiddleware"); // Import the middleware
const mysql = require("mysql2");
const bcrypt = require("bcrypt");
const axios = require("axios");

const app = express();
const port = 3000;

// Configure AWS SDK
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME;
console.log("VERSION 1.2");

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Login endpoint
app.post("/login", (req, res) => {
  const { username, password } = req.body;

  // Create MySQL connection
  const connection = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  connection.query(
    "SELECT * FROM users WHERE username = ?",
    [username],
    (err, results) => {
      if (err) {
        console.error("Error during login:", err);
        return res.status(500).json({ error: "Internal Server Error" });
      }

      if (results.length === 0) {
        return res.status(401).json({ error: "Invalid username or password" });
      }

      const user = results[0];

      // Validate password
      bcrypt.compare(password, user.password, (err, isMatch) => {
        if (err) {
          console.error("Error during password validation:", err);
          return res.status(500).json({ error: "Internal Server Error" });
        }

        if (!isMatch) {
          return res
            .status(401)
            .json({ error: "Invalid username or password" });
        }

        // Generate JWT token with 1 day expiration
        const token = jwt.sign(
          { id: user.id, username: user.username },
          process.env.JWT_SECRET,
          { expiresIn: "1d" }
        );
        res.json({ token });
      });
    }
  );
});

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
    const command = new GetObjectCommand(params);
    const data = await s3.send(command);
    const bodyContents = await streamToString(data.Body);
    return JSON.parse(bodyContents);
  } catch (err) {
    if (err.name === "NoSuchKey") {
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
    const command = new PutObjectCommand(params);
    await s3.send(command);
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

app.post("/otthonfelujitaspassword", async (req, res) => {
  const { hash } = req.query;
  const { password } = req.body;

  if (!hash) {
    return res.status(400).json({ error: "Please provide a hash" });
  }

  if (!password) {
    return res.status(400).json({ error: "Please provide a password" });
  }

  try {
    const connection = mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME_OTTHONFELUJITAS,
      port: process.env.DB_PORT,
    });

    const query = "SELECT * FROM users WHERE hash = ?";
    connection.query(query, [hash], async (err, results) => {
      if (err) {
        console.error("Error fetching user:", err);
        res
          .status(500)
          .json({ error: "Internal Server Error", success: false });
      } else if (results.length === 0) {
        res.status(404).json({ error: "User not found", success: false });
      } else {
        try {
          const user = results[0];
          if (user.password !== password) {
            return res
              .status(401)
              .json({ error: "Invalid password", success: false });
          }
          const params = {};
          let paramsString = "";
          if (user.nev) {
            params.Name = user.nev;
            paramsString = `Name=${user.nev}`;
          }
          params.CategoryId = 71;
          paramsString = `${paramsString}&CategoryId=${71}`;
          const response = await axios.get(
            `${process.env.MINICRM_API_URL_CARD}?${paramsString}`,
            {
              auth: {
                username: process.env.MINICRM_SYSTEM_ID,
                password: process.env.MINICRM_API_KEY,
              },
            }
          );

          if (response.data.Count === 0) {
            return res
              .status(404)
              .json({ error: "User not found by name", success: false });
          }

          if (response.data.Count === 1) {
            const response2 = await axios.get(
              `${process.env.MINICRM_API_URL_CARD}/${
                Object.values(response.data.Results)[0].Id
              }`,
              {
                auth: {
                  username: process.env.MINICRM_SYSTEM_ID,
                  password: process.env.MINICRM_API_KEY,
                },
              }
            );

            if (response2.data.Count === 0) {
              return res
                .status(404)
                .json({ error: "User not found by id", success: false });
            }

            const params = {};
            params.MainContactId = Object.values(
              response.data.Results
            )[0].ContactId;

            const response3 = await axios.get(
              process.env.MINICRM_API_URL_CONTACT,
              {
                auth: {
                  username: process.env.MINICRM_SYSTEM_ID,
                  password: process.env.MINICRM_API_KEY,
                },
                params,
              }
            );

            if (response3.data.Count === 0) {
              return res
                .status(404)
                .json({ error: "User not found response3", success: false });
            }

            const adatok = Object.values(response3.data.Results)[0];
            delete adatok.Id;
            delete results[0].id;
            res.json({
              ...response2.data,
              ...adatok,
              ...results[0],
              ...{ success: true },
            });
          } else {
            res.json({ ...response.data, ...{ success: true } });
          }
        } catch (error) {
          console.error("Error fetching user from MiniCRM:", error);
          res
            .status(500)
            .json({ error: "Internal Server Error", success: false });
        }
      }
      connection.end();
    });
  } catch (error) {
    console.error("Failed to fetch user", error);
    res.status(500).json({ error: "Internal Server Error", success: true });
  }
});

app.post("/saveOtthonfelujitas", async (req, res) => {
  const { hash, password } = req.query;

  if (!hash && !password) {
    return res.status(400).json({ error: "Please provide an id" });
  }

  try {
    const params = {};
    if (hash) params.hash = hash;
    if (password) params.password = password;

    const connection = mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME_OTTHONFELUJITAS,
      port: process.env.DB_PORT,
    });

    const query = "SELECT * FROM users WHERE hash = ?";
    connection.query(query, [hash, password], async (err, results) => {
      if (err) {
        console.error("Error fetching user:", err);
        res.status(500).json({ error: "Internal Server Error", success: true });
      } else if (results.length === 0) {
        res.status(404).json({ error: "User not found", success: true });
      } else {
        try {
          const user = results[0];
          if (user.password !== password && user.hash !== hash) {
            return res
              .status(401)
              .json({ error: "Invalid password", success: true });
          }
          const params = {};
          let paramsString = "";
          if (user.nev) {
            params.Name = user.nev;
            paramsString = `Name=${user.nev}`;
          }
          params.CategoryId = 71;
          paramsString = `${paramsString}&CategoryId=${71}`;
          const response = await axios.get(
            `${process.env.MINICRM_API_URL_CARD}?${paramsString}`,
            {
              auth: {
                username: process.env.MINICRM_SYSTEM_ID,
                password: process.env.MINICRM_API_KEY,
              },
            }
          );

          if (response.data.Count === 0) {
            return res.status(404).json({ error: "User not found by name" });
          }

          if (response.data.Count === 1) {
            const body = req.body;

            if (!Object.values(response.data.Results)[0].Id) {
              return res.status(400).json({ error: "Please provide an id" });
            }

            try {
              const response2 = await axios.put(
                `${process.env.MINICRM_API_URL_CARD}/${
                  Object.values(response.data.Results)[0].Id
                }`,
                body,
                {
                  auth: {
                    username: process.env.MINICRM_SYSTEM_ID,
                    password: process.env.MINICRM_API_KEY,
                  },
                }
              );

              res.json({ ...response.data, ...{ success: true } });
            } catch (error) {
              console.error("Error uploading file to MiniCRM:", error);
              res.status(500).json({ error: "Internal Server Error" });
            }
          } else {
            return res.status(404).json({ error: "User not found by name" });
          }
        } catch (error) {
          console.error("Error fetching user from MiniCRM:", error);
          res.status(500).json({ error: "Internal Server Error" });
        }
      }
      connection.end();
    });
  } catch (error) {
    console.error("Failed to save user", error);
    res.status(500).json({ error: "Internal Server Error", success: false });
  }
});

// Apply authMiddleware to all routes below this line
app.use(authMiddleware);

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
    const upload = new Upload({
      client: s3,
      params,
    });
    const data = await upload.done();
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
    const command = new DeleteObjectCommand(params);
    await s3.send(command);
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
      const command = new DeleteObjectCommand(params);
      await s3.send(command);
    }
    const params = {
      Bucket: BUCKET_NAME,
      Key: `files/${newId}${path.extname(req.file.originalname)}`,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    };
    const upload = new Upload({
      client: s3,
      params,
    });
    const data = await upload.done();
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

app.get("/minicrm/user", authMiddleware, async (req, res) => {
  const { name, email, phone } = req.query;

  if (!name && !email && !phone) {
    return res
      .status(400)
      .json({ error: "Please provide a name, email, or phone number" });
  }

  try {
    const params = {};
    if (name) params.Name = name;
    if (email) params.Email = email;
    if (phone) params.Phone = phone;

    const response = await axios.get(process.env.MINICRM_API_URL_CONTACT, {
      auth: {
        username: process.env.MINICRM_SYSTEM_ID,
        password: process.env.MINICRM_API_KEY,
      },
      params,
    });

    if (response.data.Count === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json(response.data.Results);
  } catch (error) {
    console.error("Error fetching user from MiniCRM:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/minicrm/user2", authMiddleware, async (req, res) => {
  const { name, email, phone } = req.query;

  // if (!name && !email && !phone) {
  //   return res
  //     .status(400)
  //     .json({ error: "Please provide a name, email, or phone number" });
  // }

  try {
    const params = {};
    // if (name) params.Name = name;
    // if (email) params.Email = email;
    // if (phone) params.Phone = phone;

    params.MainContactId = 47734;

    const response = await axios.get(process.env.MINICRM_API_URL_CONTACT, {
      auth: {
        username: process.env.MINICRM_SYSTEM_ID,
        password: process.env.MINICRM_API_KEY,
      },
      params,
    });

    if (response.data.Count === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json(response.data.Results);
  } catch (error) {
    console.error("Error fetching user from MiniCRM:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/minicrm/fullUser", authMiddleware, async (req, res) => {
  const { Name, CategoryId, StatusId } = req.query;

  if (!Name && !CategoryId && !StatusId) {
    return res.status(400).json({ error: "Please provide an id" });
  }

  try {
    const params = {};
    let paramsString = "";
    if (Name) {
      params.Name = Name;
      paramsString = `Name=${Name}`;
    }
    if (CategoryId) {
      params.CategoryId = CategoryId;
      paramsString = `${paramsString}&CategoryId=${CategoryId}`;
    }
    if (StatusId) {
      params.StatusId = StatusId;
      paramsString = `${paramsString}&StatusId=${StatusId}`;
    }
    const response = await axios.get(
      `${process.env.MINICRM_API_URL_CARD}?${paramsString}`,
      {
        auth: {
          username: process.env.MINICRM_SYSTEM_ID,
          password: process.env.MINICRM_API_KEY,
        },
      }
    );

    if (response.data.Count === 0) {
      return res.status(404).json({ error: "User not found by name" });
    }

    if (response.data.Count === 1) {
      const response2 = await axios.get(
        `${process.env.MINICRM_API_URL_CARD}/${
          Object.values(response.data.Results)[0].Id
        }`,
        {
          auth: {
            username: process.env.MINICRM_SYSTEM_ID,
            password: process.env.MINICRM_API_KEY,
          },
        }
      );

      if (response2.data.Count === 0) {
        return res.status(404).json({ error: "User not found by id" });
      }

      const params = {};
      params.MainContactId = Object.values(response.data.Results)[0].ContactId;

      const response3 = await axios.get(process.env.MINICRM_API_URL_CONTACT, {
        auth: {
          username: process.env.MINICRM_SYSTEM_ID,
          password: process.env.MINICRM_API_KEY,
        },
        params,
      });

      if (response3.data.Count === 0) {
        return res.status(404).json({ error: "User not found response3" });
      }

      const adatok = Object.values(response3.data.Results)[0];
      delete adatok.Id;

      res.json({ ...response2.data, ...adatok });
    } else {
      res.json(response.data);
    }
  } catch (error) {
    console.error("Error fetching user from MiniCRM:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/minicrm/smallUser", authMiddleware, async (req, res) => {
  const { Name, CategoryId, StatusId } = req.query;

  if (!Name && !CategoryId && !StatusId) {
    return res.status(400).json({ error: "Please provide an id" });
  }

  try {
    const params = {};
    if (Name) params.Name = Name;
    if (CategoryId) params.CategoryId = CategoryId;
    if (StatusId) params.StatusId = StatusId;

    const response = await axios.get(
      `${process.env.MINICRM_API_URL_CARD}?Name=${Name}&CategoryId=${CategoryId}&StatusId=${StatusId}`,
      {
        auth: {
          username: process.env.MINICRM_SYSTEM_ID,
          password: process.env.MINICRM_API_KEY,
        },
      }
    );

    if (response.data.Count === 0) {
      return res.status(404).json({ error: "User not found by name" });
    }

    if (response.data.Count === 1) {
      const response2 = await axios.get(
        `${process.env.MINICRM_API_URL_CARD}/${
          Object.values(response.data.Results)[0].Id
        }`,
        {
          auth: {
            username: process.env.MINICRM_SYSTEM_ID,
            password: process.env.MINICRM_API_KEY,
          },
        }
      );

      if (response2.data.Count === 0) {
        return res.status(404).json({ error: "User not found by id" });
      }

      res.json(response2.data);
    } else {
      res.json(response.data);
    }
  } catch (error) {
    console.error("Error fetching user from MiniCRM:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/otthonfelujitas", authMiddleware, async (req, res) => {
  const { nev } = req.query;

  if (!nev) {
    return res.status(400).json({ error: "Please provide a name" });
  }

  try {
    const connection = mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME_OTTHONFELUJITAS,
      port: process.env.DB_PORT,
    });

    const query = "SELECT * FROM users WHERE nev = ?";
    connection.query(query, [nev], async (err, results) => {
      if (err) {
        console.error("Error fetching user:", err);
        res.status(500).json({ error: "Internal Server Error" });
      } else if (results.length === 0) {
        res.status(404).json({ error: "User not found" });
      } else {
        try {
          const params = {};
          let paramsString = "";
          if (nev) {
            params.Name = nev;
            paramsString = `Name=${nev}`;
          }
          params.CategoryId = 71;
          paramsString = `${paramsString}&CategoryId=${71}`;
          const response = await axios.get(
            `${process.env.MINICRM_API_URL_CARD}?${paramsString}`,
            {
              auth: {
                username: process.env.MINICRM_SYSTEM_ID,
                password: process.env.MINICRM_API_KEY,
              },
            }
          );

          if (response.data.Count === 0) {
            return res.status(404).json({ error: "User not found by name" });
          }

          if (response.data.Count === 1) {
            const response2 = await axios.get(
              `${process.env.MINICRM_API_URL_CARD}/${
                Object.values(response.data.Results)[0].Id
              }`,
              {
                auth: {
                  username: process.env.MINICRM_SYSTEM_ID,
                  password: process.env.MINICRM_API_KEY,
                },
              }
            );

            if (response2.data.Count === 0) {
              return res.status(404).json({ error: "User not found by id" });
            }

            const params = {};
            params.MainContactId = Object.values(
              response.data.Results
            )[0].ContactId;

            const response3 = await axios.get(
              process.env.MINICRM_API_URL_CONTACT,
              {
                auth: {
                  username: process.env.MINICRM_SYSTEM_ID,
                  password: process.env.MINICRM_API_KEY,
                },
                params,
              }
            );

            if (response3.data.Count === 0) {
              return res
                .status(404)
                .json({ error: "User not found response3" });
            }

            const adatok = Object.values(response3.data.Results)[0];
            delete adatok.Id;
            delete results[0].id;
            res.json({ ...response2.data, ...adatok, ...results[0] });
          } else {
            res.json(response.data);
          }
        } catch (error) {
          console.error("Error fetching user from MiniCRM:", error);
          res.status(500).json({ error: "Internal Server Error" });
        }
      }
      connection.end();
    });
  } catch (error) {
    console.error("Failed to fetch user", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/minicrm/test2", authMiddleware, async (req, res) => {
  const { ContactId } = req.query;

  if (!ContactId) {
    return res.status(400).json({ error: "Please provide an id" });
  }

  try {
    const params = {};
    if (ContactId) params.ContactId = ContactId;

    const response = await axios.get(
      `${process.env.MINICRM_API_URL_CARD}/${ContactId}`,
      {
        auth: {
          username: process.env.MINICRM_SYSTEM_ID,
          password: process.env.MINICRM_API_KEY,
        },
      }
    );

    if (response.data.Count === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json(response.data);
  } catch (error) {
    console.error("Error fetching user from MiniCRM:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.put("/minicrm/uploadFile", authMiddleware, async (req, res) => {
  const { id } = req.query;
  const body = req.body;

  if (!id) {
    return res.status(400).json({ error: "Please provide an id" });
  }

  try {
    const response = await axios.put(
      `${process.env.MINICRM_API_URL_CARD}/${id}`,
      body,
      {
        auth: {
          username: process.env.MINICRM_SYSTEM_ID,
          password: process.env.MINICRM_API_KEY,
        },
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error("Error uploading file to MiniCRM:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.put("/minicrm/addUser", authMiddleware, async (req, res) => {
  const body = req.body;

  try {
    const response = await axios.put(
      `${process.env.MINICRM_API_URL_CONTACT}`,
      body,
      {
        auth: {
          username: process.env.MINICRM_SYSTEM_ID,
          password: process.env.MINICRM_API_KEY,
        },
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error("Error uploading file to MiniCRM:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.put("/minicrm/addUser2", authMiddleware, async (req, res) => {
  const body = req.body;

  try {
    const response = await axios.put(
      `${process.env.MINICRM_API_URL_CARD}`,
      body,
      {
        auth: {
          username: process.env.MINICRM_SYSTEM_ID,
          password: process.env.MINICRM_API_KEY,
        },
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error("Error uploading file to MiniCRM:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

// Helper function to convert stream to string
const streamToString = (stream) => {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
};
