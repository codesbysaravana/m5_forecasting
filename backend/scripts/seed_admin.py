import sys
import os

# Add the backend directory to sys.path so we can import from db
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from db.db import db
from utils.auth_utils import encrypt_password

def seed_admin():
    email = "admin@m5.com"
    password = "adminpassword"
    
    sql_check = "SELECT id FROM users WHERE email = %s;"
    existing = db.execute_query(sql_check, (email,), fetch=True)
    if existing:
        print(f"✅ Admin account already exists: {email}")
        return

    # Create admin
    encrypted_pass = encrypt_password(password)
    sql_insert = "INSERT INTO users (email, password_hash, role, store_id) VALUES (%s, %s, %s, %s) RETURNING id;"
    
    try:
        result = db.execute_query(sql_insert, (email, encrypted_pass, "ADMIN", None), fetch=True)
        print(" ✅ Successfully seeded Master Admin account!")
        print(f"📧 Email: {email}")
        print(f"🔑 Password: {password}")
        print(f"👤 Role: ADMIN")
    except Exception as e:
        print(f"❌ Failed to seed admin: {e}")

if __name__ == "__main__":
    seed_admin()
