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
import { RegisterParentDto } from './dto/register-parent.dto';

@Injectable()
export class ParentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hashing: HashingService,
    private readonly token: TokenService,
  ) {}

  private readonly role: UserRole = 'PARENT';

  async register(dto: RegisterParentDto) {
    const school = await this.prisma.school.findUnique({
      where: { id: dto.schoolId },
    });
    if (!school) {
      throw new BadRequestException('Invalid schoolId');
    }

    if (dto.studentId) {
      const student = await this.prisma.student.findUnique({
        where: { id: dto.studentId },
      });
      if (!student || student.schoolId !== dto.schoolId) {
        throw new BadRequestException('Student does not belong to this school');
      }
    }

    const exists = await this.prisma.parent.findUnique({
      where: { email: dto.email },
    });
    if (exists) {
      throw new ConflictException('Email already registered');
    }

    const password = await this.hashing.hash(dto.password);
    const parent = await this.prisma.parent.create({
      data: {
        email: dto.email,
        password,
        name: dto.name,
        schoolId: dto.schoolId,
        studentId: dto.studentId,
        phone: dto.phone,
      },
    });

    return this.buildResponse(parent);
  }

  async login(dto: LoginDto) {
    const parent = await this.prisma.parent.findUnique({
      where: { email: dto.email },
    });
    if (!parent) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await this.hashing.compare(dto.password, parent.password);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.buildResponse(parent);
  }

  async getProfile(id: string) {
    const parent = await this.prisma.parent.findUnique({ where: { id } });
    if (!parent) {
      throw new NotFoundException('Parent not found');
    }
    return this.toPublic(parent);
  }

  private buildResponse(parent: {
    id: string;
    email: string;
    name: string;
    schoolId: string;
    studentId: string | null;
    phone: string | null;
  }) {
    return {
      accessToken: this.token.sign({
        sub: parent.id,
        email: parent.email,
        role: this.role,
        schoolId: parent.schoolId,
      }),
      user: this.toPublic(parent),
    };
  }

  private toPublic(parent: {
    id: string;
    email: string;
    name: string;
    schoolId: string;
    studentId: string | null;
    phone: string | null;
  }) {
    return {
      id: parent.id,
      email: parent.email,
      name: parent.name,
      schoolId: parent.schoolId,
      studentId: parent.studentId,
      phone: parent.phone,
      role: this.role,
    };
  }
}
