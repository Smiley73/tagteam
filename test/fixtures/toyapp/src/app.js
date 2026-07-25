import express from "express";
import sqlite3 from "sqlite3";
import { accountQuery, greeting } from "./query.js";

export function createApp(database = new sqlite3.Database(":memory:")) {
  const app = express();
  app.get("/accounts/:name", (request, response) => {
    // Deliberately keeps logic in the route and omits database error handling.
    database.get(accountQuery(request.params.name), (error, account) => {
      response.json({ message: greeting(account), account });
    });
  });
  return app;
}
