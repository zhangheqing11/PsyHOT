// Sign-in paths read from the final address: a redirect that lands on one must be read as the site
// asking us to authenticate, not as an article (the extract.ts failure case), and a listing's link to one
// is navigation, not a post. Failure case: Devise answers /users/sign_in and WordPress /wp-login.php,
// neither on the first path list, so the login page passed the length test and became the body.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isSignInRedirect, isSignInUrl } from "@aihot/backend/content/extract";

test("recognizes the sign-in paths common sites use", () => {
  assert.equal(isSignInUrl("https://gitlab.com/users/sign_in"), true);
  assert.equal(isSignInUrl("https://x.com/wp-login.php"), true);
  assert.equal(isSignInUrl("https://x.com/member/login.php"), true);
  assert.equal(isSignInUrl("https://x.com/en/register.html"), true);
  assert.equal(isSignInUrl("https://x.com/users/sign_up"), true);
  assert.equal(isSignInUrl("https://x.com/login"), true);
  assert.equal(isSignInUrl("https://login.baseten.co/sign-up"), true);
  assert.equal(isSignInUrl("https://x.com/account/login?next=%2Fpost"), true);
});

test("a redirect that lands on one of those is a sign-in redirect", () => {
  assert.equal(isSignInRedirect("https://x.com/post/1", "https://x.com/users/sign_in"), true);
  assert.equal(isSignInRedirect("https://x.com/post/1", "https://x.com/wp-login.php?redirect_to=https%3A%2F%2Fx.com%2Fpost%2F1"), true);
  assert.equal(isSignInRedirect("https://x.com/post/1", "https://x.com/member/login.php"), true);
});

test("still reads a page that merely carries an auth word as content", () => {
  assert.equal(isSignInUrl("https://x.com/authorized-retailer"), false);
  assert.equal(isSignInUrl("https://x.com/authors"), false);
  assert.equal(isSignInUrl("https://x.com/sso-products"), false);
  assert.equal(isSignInUrl("https://x.com/login.company"), false);
  assert.equal(isSignInUrl("not a url"), false);
  assert.equal(isSignInRedirect("https://x.com/users/sign_in", "https://x.com/users/sign_in/"), false);
  // A registry page at .../register that only gained a trailing slash was not sent to sign in.
  assert.equal(isSignInRedirect("https://x.com/brand/register", "https://x.com/brand/register/"), false);
  assert.equal(isSignInRedirect("https://x.com/post/1", "https://x.com/post/1"), false);
});
