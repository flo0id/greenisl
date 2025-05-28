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
const mysql = require("mysql2/promise");
const bcrypt = require("bcrypt");
const axios = require("axios");

// Create a database connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 10000, // 60 seconds timeout
  acquireTimeout: 10000,
  timeout: 10000,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: true }
      : undefined,
});

// Create a separate pool for otthonfelujitas database
const otthonfelujitasPool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME_OTTHONFELUJITAS,
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 60000, // 60 seconds timeout
  acquireTimeout: 60000,
  timeout: 60000,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: true }
      : undefined,
});

// Helper function to handle database errors
const handleDatabaseError = (err, res) => {
  console.error("Database error:", err);
  if (err.code === "ETIMEDOUT" || err.code === "ECONNREFUSED") {
    return res
      .status(503)
      .json({ error: "Database connection failed. Please try again later." });
  }
  return res.status(500).json({ error: "Internal Server Error" });
};

const app = express();
const port = process.env.PORT || 3000;

// Configure AWS SDK
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME;
console.log("VERSION 1.8");

const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      "https://greenislandinvest.hu",
      "https://www.greenislandinvest.hu",
    ];
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Origin",
    "X-Requested-With",
    "Content-Type",
    "Accept",
    "Authorization",
  ],
  credentials: false,
  preflightContinue: false,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Login endpoint
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    // Get a connection from the pool
    const [results] = await pool.execute(
      "SELECT * FROM users WHERE username = ?",
      [username]
    );

    if (results.length === 0) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const user = results[0];

    // Validate password
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    // Generate JWT token with 1 day expiration
    const token = jwt.sign(
      { id: user.id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.json({ token });
  } catch (error) {
    console.error("Error during login:", error);
    handleDatabaseError(error, res);
  }
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

  const connection = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME_OTTHONFELUJITAS,
    port: process.env.DB_PORT || 3306,
    connectTimeout: 30000, // Increased timeout for production environment
    ssl:
      process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: true }
        : undefined,
  });

  try {
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
    });
  } catch (error) {
    console.error("Failed to fetch user", error);
    res.status(500).json({ error: "Internal Server Error", success: true });
  } finally {
    connection.end();
  }
});

app.post("/saveOtthonfelujitas", async (req, res) => {
  const { hash, password, nev } = req.query;

  if (!hash && !password) {
    return res.status(400).json({ error: "Please provide an id" });
  }

  try {
    const params = {};
    if (hash) params.hash = hash;
    if (password) params.password = password;
    if (nev) params.nev = nev;

    // First check if user exists
    const [results] = await otthonfelujitasPool.execute(
      "SELECT * FROM users WHERE hash = ?",
      [hash]
    );

    if (results.length === 0) {
      // User doesn't exist, create new user
      await otthonfelujitasPool.execute(
        "INSERT INTO users (nev, hash, password) VALUES (?, ?, ?)",
        [nev, hash, password]
      );

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
          console.log("data.count === 0");
          return res.status(404).json({ error: "User not found by name" });
        }

        if (response.data.Count === 1) {
          const body = {
            hash: hash,
            password: password,
          };

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

            return res.json({ ...response.data, ...{ success: true } });
          } catch (error) {
            console.error("Error uploading file to MiniCRM:", error);
            return res.status(500).json({ error: "Internal Server Error" });
          }
        } else {
          return res.status(404).json({ error: "User not found by name" });
        }
      } catch (error) {
        console.error("Error fetching user from MiniCRM:", error);
        return res.status(500).json({ error: "Internal Server Error" });
      }
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
          console.log("data.count === 0");
          return res.status(404).json({ error: "User not found by name" });
        }

        if (response.data.Count === 1) {
          const body = req.body;

          if (!Object.values(response.data.Results)[0].Id) {
            console.log("response.data.results[0].id missing");
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
  } catch (error) {
    console.error("Failed to save user", error);
    res.status(500).json({ error: "Internal Server Error", success: false });
  }
});

app.put("/minicrm/addUser", async (req, res) => {
  const { recaptchaToken, ...body } = req.body;
  //sample body:
  //   {
  //     "Name": "Új lead tesztelés",
  //     "Email": "uj@statusz.com",
  //     "Phone": "+9876543210",
  //     "Type": "Business"
  //  }
  // Verify reCAPTCHA token
  try {
    const recaptchaResponse = await axios.post(
      `https://www.google.com/recaptcha/api/siteverify`,
      null,
      {
        params: {
          secret: process.env.RECAPTCHA_SECRET_KEY,
          response: recaptchaToken,
        },
      }
    );

    if (!recaptchaResponse.data.success) {
      return res
        .status(400)
        .json({ error: "Invalid reCAPTCHA token", ok: false });
    }
  } catch (error) {
    console.error("Error verifying reCAPTCHA:", error);
    return res.status(500).json({ error: "Internal Server Error", ok: false });
  }
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

    const body2 = {
      Name: body.Name,
      CategoryId: 55,
      StatusId: "Új lead weboldal",
      UserId: "Zólyomi Norbert",
      Email: body.Email,
      ContactId: response.data.Id,
    };

    try {
      const response = await axios.put(
        `${process.env.MINICRM_API_URL_CARD}`,
        body2,
        {
          auth: {
            username: process.env.MINICRM_SYSTEM_ID,
            password: process.env.MINICRM_API_KEY,
          },
        }
      );

      res.json({ ...response.data, ok: true });
    } catch (error) {
      console.error("Error uploading file to MiniCRM:", error);
      res.status(500).json({ error: "Internal Server Error", ok: false });
    }
  } catch (error) {
    console.error("Error uploading file to MiniCRM:", error);
    res.status(500).json({ error: "Internal Server Error", ok: false });
  }
});

// Apply authMiddleware to all routes below this line
app.use(authMiddleware);

app.post("/blog", upload.single("file"), async (req, res) => {
  const { title, content } = req.body;

  console.log(title, content, req.file);

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
    const s3 = new S3Client({
      region: process.env.AWS_REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });

    const params = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: `files/${id}${path.extname(req.file.originalname)}`,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    };

    try {
      const command = new PutObjectCommand(params);
      await s3.send(command);
      fileUrl = `https://${process.env.S3_BUCKET_NAME}.s3.${
        process.env.AWS_REGION
      }.amazonaws.com/files/${id}${path.extname(req.file.originalname)}`;
    } catch (error) {
      console.error("Error uploading file to S3:", error);
      return res.status(500).json({ error: "Error uploading file to S3" });
    }
  }

  // Save the blog post with the file URL
  const newBlog = { id, title, content, fileUrl };
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
  const { Name, CategoryId, StatusId, Id } = req.query;

  if (!Name && !CategoryId && !StatusId && !Id) {
    return res.status(400).json({ error: "Please provide an id" });
  }

  try {
    const params = {};
    let paramsString = "";
    if (Id) {
      params.Id = Id;
      paramsString = `Id=${Id}`;
    }
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
      params.MainContactId = Object.values(response.data.Results)[0].BusinessId
        ? Object.values(response.data.Results)[0].BusinessId
        : Object.values(response.data.Results)[0].ContactId;

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
    const [results] = await otthonfelujitasPool.execute(
      "SELECT * FROM users WHERE nev = ?",
      [nev]
    );
    console.log(results);

    if (results.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

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
        return res
          .status(404)
          .json({ ...results[0], ...{ error: "User not found by name" } });
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
            .json({ ...results[0], ...{ error: "User not found by id" } });
        }

        const params = {};
        params.MainContactId = Object.values(
          response.data.Results
        )[0].ContactId;

        const response3 = await axios.get(process.env.MINICRM_API_URL_CONTACT, {
          auth: {
            username: process.env.MINICRM_SYSTEM_ID,
            password: process.env.MINICRM_API_KEY,
          },
          params,
        });

        if (response3.data.Count === 0) {
          return res.status(404).json({
            ...results[0],
            ...{ error: "User not found response3" },
          });
        }

        const adatok = Object.values(response3.data.Results)[0];
        delete adatok.Id;
        delete results[0].id;
        return res.json({ ...response2.data, ...adatok, ...results[0] });
      } else {
        res.json(response.data);
      }
    } catch (error) {
      console.error("Error fetching user from MiniCRM:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  } catch (error) {
    console.error("Failed to fetch user", error);
    handleDatabaseError(error, res);
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

// Endpoint to get and increment order numbers
app.get("/order-number/:type", authMiddleware, (req, res) => {
  const { type } = req.params;

  // Validate type parameter
  if (type !== "contract" && type !== "order") {
    return res
      .status(400)
      .json({ error: "Type must be either 'contract' or 'order'" });
  }

  const connection = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME_OTTHONFELUJITAS,
    port: process.env.DB_PORT || 3306,
    connectTimeout: 30000, // Increased timeout for production environment
    ssl:
      process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: true }
        : undefined,
  });

  try {
    // First get the current number
    connection.query(
      "SELECT current_number FROM order_numbers WHERE type = ?",
      [type],
      (err, results) => {
        if (err) {
          console.error(`Error fetching ${type} number:`, err);
          connection.end();
          return res.status(500).json({ error: "Internal Server Error" });
        }

        if (results.length === 0) {
          connection.end();
          return res.status(404).json({ error: `No ${type} number found` });
        }

        const currentNumber = results[0].current_number;

        // Then increment the number
        connection.query(
          "UPDATE order_numbers SET current_number = current_number + 1 WHERE type = ?",
          [type],
          (err) => {
            if (err) {
              console.error(`Error incrementing ${type} number:`, err);
              connection.end();
              return res.status(500).json({ error: "Internal Server Error" });
            }

            connection.end();
            res.json({ type, number: currentNumber });
          }
        );
      }
    );
  } catch (error) {
    console.error(`Error processing ${type} number request:`, error);
    connection.end();
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
