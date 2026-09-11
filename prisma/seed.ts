import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const email = process.env.SUPER_ADMIN_EMAIL;
  const password = process.env.SUPER_ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error(
      'SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must be set to seed a Super Admin',
    );
  }

  const firstName = process.env.SUPER_ADMIN_FIRST_NAME ?? 'Platform';
  const lastName = process.env.SUPER_ADMIN_LAST_NAME ?? 'Admin';
  const hashed = await bcrypt.hash(password, 10);

  const user = await prisma.user.upsert({
    where: { email },
    update: {
      password: hashed,
      isSuperAdmin: true,
      firstName,
      lastName,
    },
    create: {
      email,
      password: hashed,
      firstName,
      lastName,
      isSuperAdmin: true,
    },
  });

  console.log(`Seeded Super Admin: ${user.email} (${user.id})`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
