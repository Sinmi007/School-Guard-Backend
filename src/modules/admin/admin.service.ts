import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { HashingService } from '../../common/hashing/hashing.service';
import { TokenService, UserRole } from '../../common/auth/token.service';
import { LoginDto } from '../../common/auth/dto/login.dto';
import { RegisterAdminDto } from './dto/register-admin.dto';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
    private readonly token: TokenService,
  ) {}

  private readonly role: UserRole = 'ADMIN';

  async register(dto: RegisterAdminDto) {
    const school = await this.prisma.school.findUnique({
      where: { id: dto.schoolId },
    });
    if (!school) {
      throw new BadRequestException('Invalid schoolId');
    }

    const exists = await this.prisma.admin.findUnique({
      where: { email: dto.email },
    });
    if (exists) {
      throw new ConflictException('Email already registered');
    }

    const password = await this.hashing.hash(dto.password);
    const admin = await this.prisma.admin.create({
      data: {
        email: dto.email,
        password,
        name: dto.name,
        schoolId: dto.schoolId,
      },
    });

    return this.buildResponse(admin);
  }

  async login(dto: LoginDto) {
    const admin = await this.prisma.admin.findUnique({
      where: { email: dto.email },
    });
    if (!admin) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await this.hashing.compare(dto.password, admin.password);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.buildResponse(admin);
  }

  async getProfile(id: string) {
    const admin = await this.prisma.admin.findUnique({ where: { id } });
    if (!admin) {
      throw new NotFoundException('Admin not found');
    }
    return this.toPublic(admin);
  }

  private buildResponse(admin: {
    id: string;
    email: string;
    name: string;
    schoolId: string;
  }) {
    return {
      accessToken: this.token.sign({
        sub: admin.id,
        email: admin.email,
        role: this.role,
        schoolId: admin.schoolId,
      }),
      user: this.toPublic(admin),
    };
  }

  private toPublic(admin: {
    id: string;
    email: string;
    name: string;
    schoolId: string;
  }) {
    return {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      schoolId: admin.schoolId,
      role: this.role,
    };
  }
}
